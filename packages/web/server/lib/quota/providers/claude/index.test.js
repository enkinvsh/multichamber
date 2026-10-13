import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credential = vi.fn();

vi.mock('./auth.js', () => ({
  loadClaudeCredential: () => credential(),
}));

import { fetchQuota, isConfigured, resetClaudeQuotaCache } from './index.js';

const CREDENTIAL = {
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
  expiresAt: Date.now() + 3_600_000,
  planLabel: 'max',
  source: 'keychain',
};

const PAYLOAD = {
  limits: [
    { kind: 'session', percent: 5, resets_at: '2026-08-14T19:10:00Z', scope: null },
    { kind: 'weekly_all', percent: 4, resets_at: '2026-08-20T15:00:00Z', scope: null },
  ],
};

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
});

const errorResponse = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
});

beforeEach(() => {
  resetClaudeQuotaCache();
  credential.mockReturnValue(CREDENTIAL);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Claude quota provider', () => {
  it('reports not configured when no credential source has a token', async () => {
    credential.mockReturnValue(null);

    expect(isConfigured()).toBe(false);
    const result = await fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('returns windows and the plan label from the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('max');
    expect(result.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('coalesces concurrent refreshes into one Anthropic request', async () => {
    let resolveResponse;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchQuota();
    const second = fetchQuota();
    resolveResponse(jsonResponse(PAYLOAD));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
  });

  it('keeps serving the last good values while Anthropic rate limits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '120' }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    const rateLimited = await fetchQuota();

    expect(rateLimited.ok).toBe(true);
    expect(rateLimited.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('does not call Anthropic again while the rate-limit cooldown is active', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    await fetchQuota();
    await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never shows one account cached values after the credential changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    credential.mockReturnValue({ ...CREDENTIAL, accessToken: 'access-b', refreshToken: 'refresh-b', planLabel: null });
    const afterSwitch = await fetchQuota();

    expect(afterSwitch.ok).toBe(false);
    expect(afterSwitch.usage).toBeNull();
  });

  it('explains an expired session instead of reporting a bare 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401)));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('Claude Code');
  });

  it('surfaces a network failure instead of an empty successful result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('socket hang up');
  });
});

describe('Claude quota provider behind the zeny proxy', () => {
  const MANAGED_URL = 'http://10.88.0.1:8320/usage';

  // Прокси отвечает как Anthropic /api/oauth/usage в старом формате с окнами по полям.
  const MANAGED_PAYLOAD = {
    five_hour: { utilization: 12, resets_at: '2026-10-13T20:00:00Z' },
    seven_day: { utilization: 40, resets_at: '2026-10-17T09:00:00Z' },
    seven_day_opus: { utilization: 100, resets_at: '2026-10-17T09:00:00Z' },
    seven_day_sonnet: null,
  };

  beforeEach(() => {
    vi.stubEnv('MULTICHAMBER_CLAUDE_USAGE_URL', MANAGED_URL);
    credential.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is configured by the proxy address alone', () => {
    expect(isConfigured()).toBe(true);
  });

  it('asks the proxy without any token and reads the Anthropic usage format', async () => {
    credential.mockReturnValue(CREDENTIAL);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MANAGED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MANAGED_URL);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(12);
    expect(result.usage.windows['7d'].usedPercent).toBe(40);
  });

  it('reports not configured when the proxy has no connected account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(404)));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('does not send the owner to Claude Code when access was revoked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401)));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Claude access was revoked. Connect Claude again in the zeny cabinet: zenyweb.com/cabinet/claude.');
    expect(result.error).not.toContain('Claude Code');
  });

  it('drops the cached values once the proxy says the account is gone', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(MANAGED_PAYLOAD))
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();
    await fetchQuota();
    const afterReconnect = await fetchQuota();

    expect(afterReconnect.ok).toBe(false);
    expect(afterReconnect.usage).toBeNull();
  });
});
