import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import {
  isComposerDictationAllowed,
  setMultichamberDictationForTests,
  setMultichamberLockdownForTests,
  useMultichamberDictation,
  useMultichamberLockdown,
} from './lockdown';

const seen: boolean[] = [];

const Harness = () => {
  seen.push(isComposerDictationAllowed({
    preference: true,
    lockdown: useMultichamberLockdown(),
    managedDictation: useMultichamberDictation(),
  }));
  return null;
};

describe('composer mic under MultiChamber policy', () => {
  let dom: Window;
  let root: Root;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    seen.length = 0;
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
  });

  test('lockdown without managed STT hides the mic', async () => {
    setMultichamberLockdownForTests(true);
    await act(async () => root.render(<Harness />));
    expect(seen.at(-1)).toBe(false);
  });

  test('lockdown with managed STT shows the mic', async () => {
    setMultichamberDictationForTests(true);
    await act(async () => root.render(<Harness />));
    expect(seen.at(-1)).toBe(true);
  });

  test('unlocked server shows the mic', async () => {
    setMultichamberLockdownForTests(false);
    await act(async () => root.render(<Harness />));
    expect(seen.at(-1)).toBe(true);
  });
});
