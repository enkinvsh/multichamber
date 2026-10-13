import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { I18nProvider as I18nProviderComponent, useI18nStore as I18nStoreHook } from '@/lib/i18n';
import type { MultichamberClaudePage as ClaudePageComponent } from './MultichamberClaudePage';

const CABINET_URL = 'https://zenyweb.com/cabinet/claude';
const APPLIED_TEXT = 'Done. Agents now use the models chosen in the cabinet.';
const FAILED_TEXT = 'The change is saved, but OpenCode did not restart.';

describe('MultichamberClaudePage', () => {
  let dom: Window;
  let root: Root;
  let I18nProvider: typeof I18nProviderComponent;
  let useI18nStore: typeof I18nStoreHook;
  let MultichamberClaudePage: typeof ClaudePageComponent;
  let container: HTMLElement;
  let requests: string[];
  let restarts: string[];
  let failRestart: boolean;
  let restartGate: Promise<void> | null;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;

  const restartOpenCode = async (message: string) => {
    restarts.push(message);
    if (restartGate) await restartGate;
    if (failRestart) throw new Error('restart failed');
  };

  beforeEach(async () => {
    dom = new Window({ url: 'https://app.zenyweb.com/settings' });
    const globals = {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      location: dom.location,
      Element: dom.Element,
      HTMLElement: dom.HTMLElement,
      Node: dom.Node,
      Event: dom.Event,
      MouseEvent: dom.MouseEvent,
      MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    requests = [];
    restarts = [];
    failRestart = false;
    restartGate = null;
    // Страница не должна ходить в сеть: вход и режим Claude живут в кабинете zeny.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${input instanceof Request ? input.url : String(input)}`);
        throw new Error('The Claude page must not make requests');
      },
      originalFetch,
    );
    // react-dom при первой загрузке решает, есть ли DOM, поэтому React-модули грузятся
    // после подмены глобалов.
    const { createRoot } = await import('react-dom/client');
    ({ I18nProvider, useI18nStore } = await import('@/lib/i18n'));
    ({ MultichamberClaudePage } = await import('./MultichamberClaudePage'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useI18nStore.getState().setLocale('en');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    useI18nStore.getState().setLocale('en');
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
  });

  // Перезапуск завершается через несколько микрозадач; макрозадача дожидается их все.
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  // Словарь ru приходит динамическим import: в отдельном процессе теста его ещё нет в кеше,
  // и без ожидания страница успела бы отрисоваться английскими строками.
  const waitForDictionary = () =>
    new Promise<void>((resolve) => {
      if (useI18nStore.getState().loadingLocale === null) {
        resolve();
        return;
      }
      const unsubscribe = useI18nStore.subscribe((state) => {
        if (state.loadingLocale !== null) return;
        unsubscribe();
        resolve();
      });
    });

  const render = async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MultichamberClaudePage restartOpenCode={restartOpenCode} />
        </I18nProvider>,
      );
    });
    await settle();
  };

  const findButton = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label) ?? null;

  const button = (label: string) => {
    const element = findButton(label);
    if (!element) throw new Error(`Missing button: ${label}`);
    return element;
  };

  const link = (label: string) => {
    const element = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent?.trim() === label);
    if (!element) throw new Error(`Missing link: ${label}`);
    return element;
  };

  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
    await settle();
  };

  test('the page sends the owner to the cabinet and never asks for a code', async () => {
    await render();

    const cabinet = link('Connect in the cabinet');
    expect(cabinet.getAttribute('href')).toBe(CABINET_URL);
    expect(cabinet.getAttribute('target')).toBe('_blank');
    expect(cabinet.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain(
      'Enter the Claude code only in the cabinet on zenyweb.com. It is never requested here.',
    );
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[data-settings-item="claude.account"]')).not.toBeNull();
    expect(requests).toEqual([]);
  });

  test('Apply restarts OpenCode with the new providers and reports it', async () => {
    await render();

    await click(button('Apply'));

    expect(restarts).toEqual(['Restarting OpenCode…']);
    expect(container.textContent).toContain(APPLIED_TEXT);
    expect(requests).toEqual([]);
  });

  test('Apply stays busy until the restart ends', async () => {
    let release = () => {};
    restartGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render();

    await click(button('Apply'));
    const busy = button('Apply');
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).not.toContain(APPLIED_TEXT);

    await act(async () => release());
    await settle();

    expect(button('Apply').disabled).toBe(false);
    expect(container.textContent).toContain(APPLIED_TEXT);
  });

  test('a failed restart keeps the warning and offers Restart OpenCode', async () => {
    failRestart = true;
    await render();

    await click(button('Apply'));
    expect(container.textContent).toContain(FAILED_TEXT);
    expect(findButton('Apply')).toBeNull();

    failRestart = false;
    await click(button('Restart OpenCode'));

    expect(restarts).toHaveLength(2);
    expect(container.textContent).not.toContain(FAILED_TEXT);
    expect(container.textContent).toContain(APPLIED_TEXT);
    expect(findButton('Apply')).not.toBeNull();
  });

  test('the Russian page names the cabinet and the exact Apply button from its hint', async () => {
    useI18nStore.getState().setLocale('ru');
    await waitForDictionary();
    await render();

    expect(link('Подключить в кабинете').getAttribute('href')).toBe(CABINET_URL);
    expect(container.textContent).toContain('Код от Claude вводите только в кабинете на zenyweb.com. Здесь код не спрашивают.');
    expect(container.textContent).toContain(
      'После подключения или смены режима в кабинете нажмите «Применить», чтобы агенты перешли на выбранные модели.',
    );
    expect(findButton('Применить')).not.toBeNull();
  });
});
