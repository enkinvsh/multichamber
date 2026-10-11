import type {
  DirectoryListResult,
  DiskUsage,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
} from '@openchamber/ui/lib/api/types';
import {
  FilesystemError,
  filesystemErrorFromPayload,
  parseFilesystemErrorReason,
  type FilesystemErrorReason,
} from '@openchamber/ui/lib/api/files-errors';
import {
  addRuntimeProxyHeaders,
  buildRuntimeFetchUrl,
  runtimeFetch,
  sanitizeHeadersForBrowser,
} from '@openchamber/ui/lib/runtime-fetch';
import { buildRuntimeAuthHeaders, refreshRuntimeUrlAuthToken } from '@openchamber/ui/lib/runtime-auth';
import { observeRuntimeAuthResponse } from '@openchamber/ui/lib/runtime-auth-expiry';
import { getActiveRelayTunnel } from '@openchamber/ui/lib/relay/runtime-tunnel';
import type { RuntimeUrlQuery } from '@openchamber/ui/lib/runtime-url';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');

interface WebFilesAPIOptions {
  urls?: unknown;
  getDirectory?: () => string | undefined;
}

type WebDirectoryEntry = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
};

type WebDirectoryListResponse = {
  directory?: string;
  path?: string;
  entries?: WebDirectoryEntry[];
};

type WebFileUploadResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  reason?: FilesystemErrorReason;
};

const toDirectoryListResult = (fallbackDirectory: string, payload: WebDirectoryListResponse): DirectoryListResult => {
  if (!payload || !Array.isArray(payload.entries)) {
    throw new FilesystemError('Directory listing returned an invalid response', {
      reason: 'invalid-response',
    });
  }
  const directory = normalizePath(payload?.directory || payload?.path || fallbackDirectory);

  return {
    directory,
    entries: payload.entries
      .filter((entry): entry is Required<Pick<WebDirectoryEntry, 'name' | 'path'>> & { isDirectory?: boolean } =>
        Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      )
      .map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
      })),
  };
};

const directoryHeaders = (getDirectory?: () => string | undefined, override?: string): Record<string, string> | undefined => {
  const directory = override || getDirectory?.();
  return directory ? { 'x-opencode-directory': directory } : undefined;
};

type UploadResponse = { ok: boolean; status: number; payload: unknown };

const parseJsonText = (text: string): unknown => {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Прокси может вернуть HTML-страницу ошибки — тогда сообщение возьмём из статуса.
    return {};
  }
};

// XHR нужен только ради upload.onprogress — у fetch нет прогресса отправки тела.
// Повторяет то, что делает runtimeFetch для сетевого рантайма: базовый URL, query,
// санитизация заголовков, auth-заголовки, ngrok-заголовок и учёт истечения сессии.
const uploadWithProgress = async (
  query: RuntimeUrlQuery,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (loaded: number, total: number) => void,
): Promise<UploadResponse> => {
  const url = buildRuntimeFetchUrl('/api/fs/upload', query);
  const merged = await buildRuntimeAuthHeaders(sanitizeHeadersForBrowser(headers) ?? headers);
  addRuntimeProxyHeaders(url, merged);

  return new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    merged.forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : body.size);
    };
    xhr.onload = () => {
      observeRuntimeAuthResponse(url, xhr.status);
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        payload: parseJsonText(xhr.responseText),
      });
    };
    xhr.onerror = () => reject(new FilesystemError('Network error during upload', { reason: 'unknown' }));
    xhr.onabort = () => reject(new FilesystemError('Upload aborted', { reason: 'unknown' }));
    xhr.send(body);
  });
};

type DownloadTransport = { kind: 'navigate'; urlToken?: string } | { kind: 'blob' };

// Навигация по ссылке не несёт заголовков: bearer заменяем короткоживущим oc_url_token,
// а relay-туннель и произвольные заголовки (Cloudflare Access и т.п.) ей недоступны —
// тогда остаётся загрузка в Blob.
const resolveDownloadTransport = async (): Promise<DownloadTransport> => {
  if (getActiveRelayTunnel()) return { kind: 'blob' };
  const headers = await buildRuntimeAuthHeaders();
  let hasExtraHeaders = false;
  headers.forEach((_value, key) => {
    if (key.toLowerCase() !== 'authorization') hasExtraHeaders = true;
  });
  if (hasExtraHeaders) return { kind: 'blob' };
  if (!headers.has('Authorization')) return { kind: 'navigate' };
  try {
    const urlToken = await refreshRuntimeUrlAuthToken();
    return urlToken ? { kind: 'navigate', urlToken } : { kind: 'blob' };
  } catch (error) {
    console.warn('[files] url token mint failed, falling back to blob download', error);
    return { kind: 'blob' };
  }
};

const buildNavigationUrl = (path: string, query: Record<string, string | undefined>, urlToken?: string): string => {
  return buildRuntimeFetchUrl(path, { ...query, oc_url_token: urlToken });
};

// Обычная навигация вместо fetch+Blob: браузер сам стримит файл на диск, без лимита памяти,
// и встроенные браузеры Telegram/iOS умеют передать такую ссылку системе.
const navigateToDownload = (url: string): void => {
  const a = document.createElement('a');
  a.href = url;
  // Пустое значение: имя файла берётся из Content-Disposition сервера.
  a.download = '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

const isCapacitorNative = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
};

const readFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const createWebFilesAPI = ({ getDirectory }: WebFilesAPIOptions): FilesAPI => ({
  async listDirectory(path: string, options): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams();
    if (target) {
      params.set('path', target);
    }
    if (options?.respectGitignore) {
      params.set('respectGitignore', 'true');
    }

    const response = await runtimeFetch('/api/fs/list', {
      query: params,
      headers: directoryHeaders(getDirectory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as {
        error?: string;
        reason?: unknown;
      };
      throw new FilesystemError(
        error.error || 'Failed to list directory',
        {
          reason: parseFilesystemErrorReason(error.reason),
          status: response.status,
        },
      );
    }

    const result = (await response.json()) as WebDirectoryListResponse;
    return toDirectoryListResult(target, result);
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const params = new URLSearchParams();

    const directory = normalizePath(payload.directory);
    if (directory) {
      params.set('directory', directory);
    }

    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');

    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }

    const response = await runtimeFetch('/api/find/file', {
      query: params,
      headers: directoryHeaders(getDirectory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to search files');
    }

    const result = (await response.json()) as string[];
    const files = Array.isArray(result) ? result : [];

    return files.map((relativePath) => ({
      path: normalizePath(`${directory}/${relativePath}`),
      preview: [normalizePath(relativePath)],
    }));
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to create directory');
    }

    const result = await response.json();
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizePath(result.path) : target,
    };
  },

  async statFile(path: string, options): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    const response = await runtimeFetch('/api/fs/stat', {
      query: params,
      headers: directoryHeaders(getDirectory, options?.directory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to stat file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
      isFile: Boolean((result as { isFile?: boolean }).isFile),
      size: typeof (result as { size?: number }).size === 'number' ? (result as { size: number }).size : 0,
      mtimeMs: typeof (result as { mtimeMs?: number }).mtimeMs === 'number' ? (result as { mtimeMs: number }).mtimeMs : undefined,
    };
  },

  async readFile(path: string, options): Promise<{ content: string; path: string }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    if (options?.optional) {
      params.set('optional', 'true');
    }
    const response = await runtimeFetch('/api/fs/read', {
      query: params,
      cache: options?.optional || options?.fresh ? 'no-store' : 'default',
      headers: directoryHeaders(getDirectory, options?.directory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }

    const content = await response.text();
    return { content, path: target };
  },

  async writeFile(path: string, content: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target, content }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to write file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
    };
  },

  async uploadFile(path: string, file: Blob, options): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const query = {
      path: target,
      overwrite: options?.overwrite ? 'true' : undefined,
      onConflict: options?.onConflict,
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      ...directoryHeaders(getDirectory, options?.directory),
    };
    const onProgress = options?.onProgress;

    let outcome: UploadResponse;
    // Через relay-туннель XHR не ходит — там остаётся fetch без промежуточного прогресса.
    if (onProgress && typeof XMLHttpRequest !== 'undefined' && !getActiveRelayTunnel()) {
      outcome = await uploadWithProgress(query, headers, file, onProgress);
    } else {
      const response = await runtimeFetch('/api/fs/upload', {
        method: 'POST',
        query,
        headers,
        body: file,
      });
      const payload = await response.json().catch(() => (response.ok ? {} : { error: response.statusText }));
      outcome = { ok: response.ok, status: response.status, payload };
      if (response.ok) onProgress?.(file.size, file.size);
    }

    if (!outcome.ok) {
      throw filesystemErrorFromPayload(outcome.payload, outcome.status, 'Failed to upload file');
    }

    const result = (outcome.payload ?? {}) as WebFileUploadResponse;
    return {
      success: Boolean(result.success),
      path: typeof result.path === 'string' && result.path ? normalizePath(result.path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to delete file');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const response = await runtimeFetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ oldPath, newPath }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to rename file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await runtimeFetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async downloadFile(path: string): Promise<void> {
    const target = normalizePath(path);
    const directory = getDirectory?.() || undefined;
    const capacitor = isCapacitorNative();
    const transport = capacitor ? { kind: 'blob' as const } : await resolveDownloadTransport();

    if (transport.kind === 'navigate') {
      navigateToDownload(buildNavigationUrl('/api/fs/raw', {
        path: target,
        download: 'true',
        directory,
      }, transport.urlToken));
      return;
    }

    const response = await runtimeFetch('/api/fs/raw', {
      query: { path: target, download: true },
      headers: directoryHeaders(getDirectory),
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const blob = await response.blob();
    const filename = target.split('/').pop() || 'file';
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (capacitor && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },

  async downloadDirectory(path: string): Promise<void> {
    const target = normalizePath(path);
    const directory = getDirectory?.() || undefined;
    // Предпроверка отдельным запросом: при навигации ошибку 413/429 браузер покажет
    // голой страницей вместо понятного тоста.
    const check = await runtimeFetch('/api/fs/archive', {
      query: { path: target, check: '1', directory },
      headers: directoryHeaders(getDirectory),
    });
    if (!check.ok) {
      const payload = await check.json().catch(() => ({ error: check.statusText }));
      throw filesystemErrorFromPayload(payload, check.status, 'Failed to prepare archive');
    }

    const transport = isCapacitorNative() ? { kind: 'blob' as const } : await resolveDownloadTransport();
    if (transport.kind === 'navigate') {
      navigateToDownload(buildNavigationUrl('/api/fs/archive', { path: target, directory }, transport.urlToken));
      return;
    }

    const response = await runtimeFetch('/api/fs/archive', {
      query: { path: target, directory },
      headers: directoryHeaders(getDirectory),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw filesystemErrorFromPayload(payload, response.status, 'Failed to download archive');
    }
    const blob = await response.blob();
    const filename = `${target.split('/').filter(Boolean).pop() || 'folder'}.zip`;
    const file = new File([blob], filename, { type: 'application/zip' });
    if (isCapacitorNative() && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },

  async getDiskUsage(path: string): Promise<DiskUsage> {
    const response = await runtimeFetch('/api/fs/disk', {
      query: { path: normalizePath(path) },
      headers: directoryHeaders(getDirectory),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw filesystemErrorFromPayload(payload, response.status, 'Failed to read disk usage');
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const total = readFiniteNumber(payload?.total);
    const free = readFiniteNumber(payload?.free);
    if (total === null || free === null) {
      throw new FilesystemError('Disk usage returned an invalid response', { reason: 'invalid-response' });
    }
    const used = readFiniteNumber(payload?.used) ?? Math.max(0, total - free);
    return { total, free, used };
  },
});
