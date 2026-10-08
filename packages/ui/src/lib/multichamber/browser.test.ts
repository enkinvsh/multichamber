import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { openExternalLinkInLockdown, resolveMultichamberPreviewTarget } from './browser';
import { setMultichamberLockdownForTests } from './lockdown';
import { multichamberLockedTabIds, withoutMultichamberLockedSurfaces } from './panels';

describe('resolveMultichamberPreviewTarget', () => {
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
