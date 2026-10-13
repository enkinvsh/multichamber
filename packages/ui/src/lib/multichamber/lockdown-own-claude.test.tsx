import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { setMultichamberLockdownForTests, setMultichamberOwnClaudeForTests, useMultichamberOwnClaude } from './lockdown';

const seen: boolean[] = [];

const Harness = () => {
  seen.push(useMultichamberOwnClaude());
  return null;
};

describe('own Claude under MultiChamber policy', () => {
  let dom: Window | null = null;
  let root: Root | null = null;

  const renderAt = async (url: string) => {
    dom = new Window({ url });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    seen.length = 0;
    const mounted = createRoot(document.createElement('div'));
    root = mounted;
    await act(async () => mounted.render(<Harness />));
    return seen.at(-1);
  };

  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    await dom?.happyDOM.close();
    root = null;
    dom = null;
  });

  test('the served page shows the Claude page when the plan has own Claude', async () => {
    setMultichamberOwnClaudeForTests(true);
    expect(await renderAt('https://app.zenyweb.com/')).toBe(true);
  });

  test('a locked plan without own Claude keeps it hidden', async () => {
    setMultichamberOwnClaudeForTests(false);
    expect(await renderAt('https://app.zenyweb.com/')).toBe(false);
  });

  test('a stock server never shows it', async () => {
    setMultichamberLockdownForTests(false);
    expect(await renderAt('http://localhost/')).toBe(false);
  });

  // Приложение Capacitor открывает интерфейс со своего origin, там свой Claude выключен намеренно.
  test('the Capacitor app hides it', async () => {
    setMultichamberOwnClaudeForTests(true);
    expect(await renderAt('capacitor://localhost/')).toBe(false);
  });
});
