import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { useUIStore } from '@/stores/useUIStore';
import {
  buildMultichamberPreviewUrl,
  openExternalLinkInLockdown,
  openMultichamberPreview,
  resolveMultichamberPreviewTarget,
} from './browser';
import { setMultichamberLockdownForTests, setMultichamberPreviewOpenUrlForTests } from './lockdown';
import { multichamberLockedTabIds, withoutMultichamberLockedSurfaces } from './panels';

const OPEN_URL = 'https://ai.example.test/api/preview/open';

describe('resolveMultichamberPreviewTarget', () => {
  beforeEach(() => {
    setMultichamberLockdownForTests(true);
  });

  test('opens a public site in a new tab', () => {
    expect(resolveMultichamberPreviewTarget('https://example.com/docs')).toEqual({
      kind: 'new-tab',
      url: 'https://example.com/docs',
    });
  });

  test('normalizes a schemeless public host to https', () => {
    expect(resolveMultichamberPreviewTarget('example.com')).toEqual({ kind: 'new-tab', url: 'https://example.com/' });
  });

  for (const url of [
    'http://localhost:8123/',
    'localhost:5173',
    'http://127.0.0.1:3000/app',
    'http://0.0.0.0:8080',
    'http://[::1]:4000/',
  ]) {
    test(`treats ${url} as a workspace address`, () => {
      expect(resolveMultichamberPreviewTarget(url)).toEqual({ kind: 'workspace-loopback' });
    });
  }

  for (const url of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd']) {
    test(`refuses ${JSON.stringify(url)}`, () => {
      expect(resolveMultichamberPreviewTarget(url)).toEqual({ kind: 'unopenable' });
    });
  }
});

describe('buildMultichamberPreviewUrl', () => {
  test('carries the port and the whole path with query and hash', () => {
    const built = new URL(buildMultichamberPreviewUrl('http://localhost:5173/app/x?q=1&b=a b#top', OPEN_URL) ?? '');
    expect(`${built.origin}${built.pathname}`).toBe(OPEN_URL);
    expect(built.searchParams.get('port')).toBe('5173');
    expect(built.searchParams.get('path')).toBe('/app/x?q=1&b=a%20b#top');
  });

  test('encodes the path so it cannot add parameters of its own', () => {
    const built = buildMultichamberPreviewUrl('http://127.0.0.1:3001/a?port=22&x=1', OPEN_URL) ?? '';
    expect(built).toBe(`${OPEN_URL}?port=3001&path=%2Fa%3Fport%3D22%26x%3D1`);
  });

  for (const url of ['localhost:5173', 'http://0.0.0.0:8080', 'https://[::1]:4000/', 'http://127.0.0.1:3000/app']) {
    test(`rewrites the loopback address ${url}`, () => {
      expect(buildMultichamberPreviewUrl(url, OPEN_URL)?.startsWith(`${OPEN_URL}?port=`)).toBe(true);
    });
  }

  test('leaves public, portless and unconfigured addresses alone', () => {
    expect(buildMultichamberPreviewUrl('https://example.com:8443/', OPEN_URL)).toBeNull();
    expect(buildMultichamberPreviewUrl('http://localhost/', OPEN_URL)).toBeNull();
    expect(buildMultichamberPreviewUrl('http://localhost:5173/', null)).toBeNull();
    expect(buildMultichamberPreviewUrl('javascript:alert(1)', OPEN_URL)).toBeNull();
  });
});

describe('private preview in lockdown', () => {
  const originalDocument = globalThis.document;
  let opened: Array<{ href: string; target: string; rel: string }> = [];

  beforeEach(() => {
    const window = new Window({ url: 'https://slot.example.test/' });
    window.document.addEventListener('click', (event) => {
      const anchor = event.target as unknown as HTMLAnchorElement;
      opened.push({ href: anchor.href, target: anchor.target, rel: anchor.rel });
      event.preventDefault();
    });
    globalThis.document = window.document as unknown as Document;
    opened = [];
    setMultichamberPreviewOpenUrlForTests(OPEN_URL);
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    setMultichamberLockdownForTests(false);
  });

  test('a loopback address resolves to the private preview', () => {
    expect(resolveMultichamberPreviewTarget('http://localhost:5173/')).toEqual({
      kind: 'private-preview',
      url: `${OPEN_URL}?port=5173&path=%2F`,
    });
  });

  test('opens the preview as a top-level new tab without opener and referrer', () => {
    openMultichamberPreview('http://localhost:5173/dash');
    expect(opened).toEqual([{ href: `${OPEN_URL}?port=5173&path=%2Fdash`, target: '_blank', rel: 'noopener noreferrer' }]);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  test('a chat link to localhost goes to the private preview, not to openExternal', () => {
    const external: string[] = [];
    openExternalLinkInLockdown('http://127.0.0.1:8123/x', (url) => external.push(url));
    expect(external).toEqual([]);
    expect(opened.map((entry) => entry.href)).toEqual([`${OPEN_URL}?port=8123&path=%2Fx`]);
  });

  test('a public chat link still opens as usual', () => {
    const external: string[] = [];
    openExternalLinkInLockdown('https://example.com/', (url) => external.push(url));
    expect(external).toEqual(['https://example.com/']);
    expect(opened).toEqual([]);
  });
});

describe('browser surface in lockdown', () => {
  const surfaces = [{ mode: 'browser' as const }, { mode: 'terminal' as const }];

  test('drops the browser surface when locked', () => {
    expect(withoutMultichamberLockedSurfaces(surfaces, true)).toEqual([{ mode: 'terminal' }]);
  });

  test('keeps the browser surface when unlocked', () => {
    expect(withoutMultichamberLockedSurfaces(surfaces, false)).toEqual(surfaces);
  });

  test('marks persisted browser tabs for closing only when locked', () => {
    const tabs = [{ id: 'browser:a', mode: 'browser' as const }, { id: 'terminal', mode: 'terminal' as const }];
    expect(multichamberLockedTabIds(tabs, true)).toEqual(['browser:a']);
    expect(multichamberLockedTabIds(tabs, false)).toEqual([]);
  });
});

describe('browser openers in the UI store', () => {
  const directory = '/repo';
  const browserTabs = () => (useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [])
    .filter((tab) => tab.mode === 'browser');

  beforeEach(() => {
    useUIStore.setState({ contextPanelByDirectory: {} });
  });

  test('a workspace preview opens no browser tab when locked', () => {
    setMultichamberLockdownForTests(true);
    useUIStore.getState().openContextPreview(directory, 'http://localhost:8123/');
    expect(browserTabs()).toEqual([]);
  });

  test('the browser surface and explicit browser tabs stay closed when locked', () => {
    setMultichamberLockdownForTests(true);
    useUIStore.getState().openContextSurface(directory, 'browser');
    useUIStore.getState().openContextBrowser(directory, 'https://example.com');
    useUIStore.getState().openNewContextBrowserTab(directory);
    expect(browserTabs()).toEqual([]);
  });

  test('a preview opens a browser tab when unlocked', () => {
    setMultichamberLockdownForTests(false);
    useUIStore.getState().openContextPreview(directory, 'http://localhost:8123/');
    expect(browserTabs().map((tab) => tab.targetPath)).toEqual(['http://localhost:8123/']);
  });
});

describe('plain chat link clicks', () => {
  const clicks = (lockdown: boolean, url: string): string[] => {
    setMultichamberLockdownForTests(lockdown);
    const opened: string[] = [];
    openExternalLinkInLockdown(url, (target) => opened.push(target));
    return opened;
  };

  test('a loopback link does not open a tab when locked', () => {
    expect(clicks(true, 'http://localhost:8123/')).toEqual([]);
  });

  test('a public link still opens when locked', () => {
    expect(clicks(true, 'https://example.com/')).toEqual(['https://example.com/']);
  });

  test('a loopback link opens as usual when unlocked', () => {
    expect(clicks(false, 'http://localhost:8123/')).toEqual(['http://localhost:8123/']);
  });
});
