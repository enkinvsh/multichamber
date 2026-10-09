import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { isHiddenUserMessage } from '../hiddenUserMessage';

const userInfo: Message = {
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
  agent: 'Sisyphus - ultraworker',
  model: { providerID: 'zeny', modelID: 'gemini-3.8-flash-high' },
};

const textPart = (text: string): Part => ({
  id: 'prt_1',
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
});

const isHidden = (text: string): boolean =>
  isHiddenUserMessage({ info: userInfo, parts: [textPart(text)] }, { planModeEnabled: false });

describe('isHiddenUserMessage', () => {
  test('hides the background task nudge oh-my-openagent sends on its own', () => {
    const nudge = [
      '<system-reminder>',
      '[BACKGROUND TASK COMPLETED]',
      '[ALL BACKGROUND TASKS COMPLETE]',
      '</system-reminder>',
      '<!-- OMO_INTERNAL_INITIATOR -->',
      '<!-- OMO_INTERNAL_NOREPLY -->',
    ].join('\n');
    expect(isHidden(nudge)).toBe(true);
  });

  test('keeps a message the user typed, even one quoting a system reminder', () => {
    expect(isHidden('Добавь функцию greet(name)')).toBe(false);
    expect(isHidden('<system-reminder>что это за блок?</system-reminder>')).toBe(false);
  });
});
