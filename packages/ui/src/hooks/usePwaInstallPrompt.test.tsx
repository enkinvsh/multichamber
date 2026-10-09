import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { setMultichamberLockdownForTests } from '@/lib/multichamber/lockdown';
import { usePwaInstallPrompt } from './usePwaInstallPrompt';

const Harness = () => {
  usePwaInstallPrompt();
  return null;
};

describe('PWA install toast', () => {
  let dom: Window;
  let root: Root;

  const offerInstall = (): boolean => {
    const event = new dom.Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    dom.dispatchEvent(event);
    return event.defaultPrevented;
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
  });

  test('takes over the browser install prompt in a stock browser tab', async () => {
    setMultichamberLockdownForTests(false);
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    expect(offerInstall()).toBe(true);
  });

  test('stays out of a hosted container in lockdown', async () => {
    setMultichamberLockdownForTests(true);
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    expect(offerInstall()).toBe(false);
  });
});
