import { describe, expect, it } from 'vitest';

import { readManagedStt } from './managed-stt.js';

describe('readManagedStt', () => {
  it('is off when the base url is missing or blank', () => {
    expect(readManagedStt({})).toBeNull();
    expect(readManagedStt({ MULTICHAMBER_STT_BASE_URL: '   ', MULTICHAMBER_STT_KEY: 'k' })).toBeNull();
  });

  it('is off when the base url is not an absolute http(s) url without credentials', () => {
    for (const value of ['10.88.0.1:8317/v1', '/v1', 'ftp://10.88.0.1/v1', 'javascript:alert(1)', 'http://user:pw@10.88.0.1/v1', 'not a url']) {
      expect(readManagedStt({ MULTICHAMBER_STT_BASE_URL: value })).toBeNull();
    }
  });

  it('reads base url, model and key from the environment', () => {
    expect(readManagedStt({
      MULTICHAMBER_STT_BASE_URL: ' http://10.88.0.1:8317/v1 ',
      MULTICHAMBER_STT_MODEL: ' whisper-large ',
      MULTICHAMBER_STT_KEY: ' stt-key ',
      MULTICHAMBER_LLM_KEY: 'llm-key',
    })).toEqual({ baseUrl: 'http://10.88.0.1:8317/v1', model: 'whisper-large', apiKey: 'stt-key' });
  });

  it('defaults the model to parakeet and the key to the llm key', () => {
    expect(readManagedStt({ MULTICHAMBER_STT_BASE_URL: 'https://stt.example.test/v1', MULTICHAMBER_LLM_KEY: 'llm-key' }))
      .toEqual({ baseUrl: 'https://stt.example.test/v1', model: 'parakeet-tdt-0.6b-v3', apiKey: 'llm-key' });
  });

  it('uses the no-key placeholder instead of any server-wide OpenAI key when no key is set', () => {
    expect(readManagedStt({ MULTICHAMBER_STT_BASE_URL: 'http://10.88.0.1:8317/v1', OPENAI_API_KEY: 'sk-secret' })?.apiKey)
      .toBe('not-required');
  });
});
