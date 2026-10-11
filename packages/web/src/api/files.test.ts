import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();
const buildRuntimeAuthHeadersMock = vi.fn(async (init?: HeadersInit) => new Headers(init));
const refreshRuntimeUrlAuthTokenMock = vi.fn(async (): Promise<string | null> => null);

afterEach(() => {
  vi.unstubAllGlobals();
  runtimeFetchMock.mockReset();
  buildRuntimeAuthHeadersMock.mockImplementation(async (init?: HeadersInit) => new Headers(init));
  refreshRuntimeUrlAuthTokenMock.mockReset();
});

const RUNTIME_BASE = 'https://slot.example';

// Повторяет форму URL настоящего buildRuntimeFetchUrl: базовый адрес + query без undefined.
const buildRuntimeFetchUrlMock = (path: string, query?: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return `${RUNTIME_BASE}${path}${queryString ? `?${queryString}` : ''}`;
};

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
  buildRuntimeFetchUrl: buildRuntimeFetchUrlMock,
  addRuntimeProxyHeaders: (_url: string, headers: Headers) => headers,
  sanitizeHeadersForBrowser: (headers: HeadersInit | undefined) => headers,
}));

vi.mock('@openchamber/ui/lib/runtime-auth', () => ({
  buildRuntimeAuthHeaders: buildRuntimeAuthHeadersMock,
  refreshRuntimeUrlAuthToken: refreshRuntimeUrlAuthTokenMock,
}));

vi.mock('@openchamber/ui/lib/runtime-auth-expiry', () => ({
  observeRuntimeAuthResponse: vi.fn(),
}));

vi.mock('@openchamber/ui/lib/relay/runtime-tunnel', () => ({
  getActiveRelayTunnel: () => null,
}));

type FakeAnchor = { href: string; download: string; rel: string; style: Record<string, string>; click: ReturnType<typeof vi.fn> };

// Минимальный document для node-окружения: ловим ссылку, по которой «кликнули».
const stubDocument = () => {
  const anchors: FakeAnchor[] = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const anchor: FakeAnchor = { href: '', download: 'unset', rel: '', style: {}, click: vi.fn() };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  });
  return anchors;
};

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  assetWithUrlToken: (path: string, _token: string, query?: RuntimeUrlQuery) => toUrl(path, query),
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('preserves the directory permission failure contract', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Access to directory denied', reason: 'os-permission' },
      { status: 403 },
    ));

    const error = await api.listDirectory('/protected').catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'FilesystemError',
      reason: 'os-permission',
      status: 403,
      message: 'Access to directory denied',
    });
  });

  it('rejects malformed successful directory listings', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace' }));

    await expect(api.listDirectory('/workspace')).rejects.toMatchObject({
      reason: 'invalid-response',
    });
  });

  it('uses per-call workspace directory for stat and read requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-opencode-directory': '/worktree-a' },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      cache: 'default',
      headers: { 'x-opencode-directory': '/worktree-a' },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('fresh content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a', fresh: true });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      cache: 'no-store',
      headers: { 'x-opencode-directory': '/worktree-a' },
    });
  });

  it('downloads a file by plain navigation with the workspace directory in the URL', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });
    const anchors = stubDocument();

    await api.downloadFile?.('/current-workspace/report.pdf');

    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    const url = new URL(anchors[0].href);
    expect(url.origin + url.pathname).toBe(`${RUNTIME_BASE}/api/fs/raw`);
    expect(url.searchParams.get('path')).toBe('/current-workspace/report.pdf');
    expect(url.searchParams.get('download')).toBe('true');
    expect(url.searchParams.get('directory')).toBe('/current-workspace');
    expect(url.searchParams.has('oc_url_token')).toBe(false);
    expect(anchors[0].download).toBe('');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('swaps a bearer header for a URL token when navigating to a download', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const anchors = stubDocument();
    buildRuntimeAuthHeadersMock.mockImplementation(async () => new Headers({ Authorization: 'Bearer secret' }));
    refreshRuntimeUrlAuthTokenMock.mockResolvedValueOnce('url-token');

    await api.downloadFile?.('/workspace/a.txt');

    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(new URL(anchors[0].href).searchParams.get('oc_url_token')).toBe('url-token');
  });

  it('falls back to a blob download with the directory header when navigation cannot carry auth', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });
    buildRuntimeAuthHeadersMock.mockImplementation(async () => new Headers({ 'cf-access-token': 'x' }));

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-opencode-directory': '/current-workspace' },
    });
  });

  it('checks the archive size before navigating to the folder zip', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const anchors = stubDocument();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace/docs', bytes: 1024, files: 3, limit: 1e9, excluded: [] }));

    await api.downloadDirectory?.('/workspace/docs');

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/archive', {
      query: { path: '/workspace/docs', check: '1', directory: '/workspace' },
      headers: { 'x-opencode-directory': '/workspace' },
    });
    const url = new URL(anchors[0].href);
    expect(url.origin + url.pathname).toBe(`${RUNTIME_BASE}/api/fs/archive`);
    expect(url.searchParams.get('path')).toBe('/workspace/docs');
    expect(url.searchParams.get('directory')).toBe('/workspace');
    expect(url.searchParams.has('check')).toBe(false);
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('reports an oversized folder archive with its size and limit', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const anchors = stubDocument();
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Archive too large', reason: 'archive_too_large', bytes: 3_000_000_000, limit: 1_073_741_824 },
      { status: 413 },
    ));

    await expect(api.downloadDirectory?.('/workspace/big')).rejects.toMatchObject({
      name: 'FilesystemError',
      reason: 'archive_too_large',
      status: 413,
      bytes: 3_000_000_000,
      limit: 1_073_741_824,
    });
    expect(anchors).toHaveLength(0);
  });

  it('reports a busy archive builder', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    stubDocument();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Busy', reason: 'archive_busy' }, { status: 429 }));

    await expect(api.downloadDirectory?.('/workspace/docs')).rejects.toMatchObject({ reason: 'archive_busy', status: 429 });
  });

  it('reads disk usage for a path', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/home/dev', total: 16_000_000_000, free: 12_000_000_000, used: 4_000_000_000 }));

    await expect(api.getDiskUsage?.('/home/dev')).resolves.toEqual({
      total: 16_000_000_000,
      free: 12_000_000_000,
      used: 4_000_000_000,
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/disk', {
      query: { path: '/home/dev' },
      headers: { 'x-opencode-directory': '/workspace' },
    });
  });

  it('rejects a malformed disk usage response', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/home/dev' }));

    await expect(api.getDiskUsage?.('/home/dev')).rejects.toMatchObject({ reason: 'invalid-response' });
  });

  it('uploads binary file contents to the active workspace', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const file = new Blob([new Uint8Array([0, 1, 255])]);
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/image.bin' }));

    await api.uploadFile?.('/workspace/image.bin', file, { directory: '/workspace' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/upload', {
      method: 'POST',
      query: { path: '/workspace/image.bin', overwrite: undefined, onConflict: undefined },
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-opencode-directory': '/workspace',
      },
      body: file,
    });
  });

  it('asks the server to rename on a name clash and returns the final path', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const file = new Blob(['pdf']);
    const onProgress = vi.fn();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/report (2).pdf' }));

    const result = await api.uploadFile?.('/workspace/report.pdf', file, { onConflict: 'rename', onProgress });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/upload', expect.objectContaining({
      method: 'POST',
      query: { path: '/workspace/report.pdf', overwrite: undefined, onConflict: 'rename' },
    }));
    expect(result).toEqual({ success: true, path: '/workspace/report (2).pdf' });
    // Без XMLHttpRequest (node) прогресс приходит одним финальным событием.
    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });

  it('keeps the plan limit from an oversized upload rejection', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'File too large', reason: 'file_too_large', limit: 104_857_600 },
      { status: 413 },
    ));

    await expect(api.uploadFile?.('/workspace/huge.bin', new Blob(['x']), { onConflict: 'rename' })).rejects.toMatchObject({
      reason: 'file_too_large',
      status: 413,
      limit: 104_857_600,
    });
  });

  it('preserves upload conflict details for explicit overwrite handling', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'File already exists', reason: 'already-exists' },
      { status: 409 },
    ));

    await expect(api.uploadFile?.('/workspace/file.txt', new Blob(['new']))).rejects.toMatchObject({
      reason: 'already-exists',
      status: 409,
    });
  });

  it('opens the native share sheet for downloads in the Capacitor app', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', {});
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    runtimeFetchMock.mockResolvedValueOnce(new Response('hello', { headers: { 'Content-Type': 'text/plain' } }));

    await api.downloadFile?.('/workspace/hello.txt');

    expect(share).toHaveBeenCalledWith({ files: [expect.objectContaining({ name: 'hello.txt', type: 'text/plain' })] });
  });
});
