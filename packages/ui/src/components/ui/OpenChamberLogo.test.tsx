import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { setMultichamberBrandForTests } from '@/lib/multichamber/brand';
import { OpenChamberLogo } from './OpenChamberLogo';

describe('brand logo on the splash', () => {
  let dom: Window;
  let host: HTMLElement;
  let root: Root;

  const renderedBox = async (element: React.ReactElement) => {
    await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
    const logo = host.querySelector<HTMLElement>('[role="img"]');
    return { width: logo?.style.width, height: logo?.style.height };
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      getComputedStyle: dom.getComputedStyle.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    root = createRoot(host);
    setMultichamberBrandForTests(JSON.stringify({ name: 'Acme', logoUrl: '/brand/logo.svg' }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    setMultichamberBrandForTests(null);
    await dom.happyDOM.close();
  });

  test('keeps the box of the server-rendered loading mark', async () => {
    expect(await renderedBox(<OpenChamberLogo width={120} height={120} variant="splash" />)).toEqual({ width: '240px', height: '72px' });
  });

  test('uses the requested size everywhere else', async () => {
    expect(await renderedBox(<OpenChamberLogo width={64} height={64} />)).toEqual({ width: '64px', height: '64px' });
  });
});
