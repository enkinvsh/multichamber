import { describe, expect, test } from 'bun:test';

import {
  formatBudgetResetDuration,
  getMultichamberBudgetMode,
  getMultichamberBudgetResetKeys,
  parseMultichamberBudget,
} from './budget';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const OLD_GATEWAY_FIELDS = { fallbackPercent: null, stopped: null, preset: null, renews: null, byok: null };

describe('parseMultichamberBudget', () => {
  test('shows the weekly percent as a whole number', () => {
    const body = JSON.stringify({
      state: 'warn80',
      weekly_percent_used: 81.7,
      resets_at: '2026-10-11T12:00:00Z',
      pack_percent_used: 10,
      has_topup: true,
    });
    expect(parseMultichamberBudget(body)).toEqual({
      state: 'warn80',
      percent: 81,
      resetsAt: Date.parse('2026-10-11T12:00:00Z'),
      ...OLD_GATEWAY_FIELDS,
    });
  });

  test('falls back to the pack percent and clamps an overdraw to 100', () => {
    const body = JSON.stringify({
      state: 'exhausted',
      weekly_percent_used: null,
      resets_at: null,
      pack_percent_used: 140,
      has_topup: false,
    });
    expect(parseMultichamberBudget(body)).toEqual({
      state: 'exhausted',
      percent: 100,
      resetsAt: null,
      ...OLD_GATEWAY_FIELDS,
    });
  });

  test('keeps the indicator without a percent or a valid reset time', () => {
    expect(parseMultichamberBudget(JSON.stringify({ state: 'ok', resets_at: 'next week' }))).toEqual({
      state: 'ok',
      percent: null,
      resetsAt: null,
      ...OLD_GATEWAY_FIELDS,
    });
  });

  test('reads the fallback share, the stop flag and the preset', () => {
    const body = JSON.stringify({
      state: 'exhausted',
      weekly_percent_used: 100,
      resets_at: '2026-11-01T00:00:00+03:00',
      pack_percent_used: null,
      has_topup: false,
      fallback_percent_used: 12.5,
      stopped: false,
      preset: 'balance',
    });
    expect(parseMultichamberBudget(body)).toEqual({
      state: 'exhausted',
      percent: 100,
      resetsAt: Date.parse('2026-11-01T00:00:00+03:00'),
      fallbackPercent: 12,
      stopped: false,
      preset: 'balance',
      renews: null,
      byok: null,
    });
  });

  test('drops an unknown preset but keeps the indicator', () => {
    const body = JSON.stringify({ state: 'ok', fallback_percent_used: null, stopped: false, preset: 'turbo' });
    expect(parseMultichamberBudget(body)).toEqual({
      state: 'ok',
      percent: null,
      resetsAt: null,
      fallbackPercent: null,
      stopped: false,
      preset: null,
      renews: null,
      byok: null,
    });
  });

  test('reads the renewal and own-key flags', () => {
    const body = JSON.stringify({ state: 'warn80', stopped: false, renews: false, byok: true });
    expect(parseMultichamberBudget(body)).toMatchObject({ renews: false, byok: true });
  });

  test('rejects an unknown state and a body that is not JSON', () => {
    expect(() => parseMultichamberBudget(JSON.stringify({ state: 'maybe' }))).toThrow();
    expect(() => parseMultichamberBudget('<html>Bad gateway</html>')).toThrow();
  });
});

describe('getMultichamberBudgetMode', () => {
  test('keeps the warning states while the budget lasts', () => {
    expect(getMultichamberBudgetMode({ state: 'ok', stopped: false })).toBe('ok');
    expect(getMultichamberBudgetMode({ state: 'warn80', stopped: null })).toBe('warn80');
    expect(getMultichamberBudgetMode({ state: 'warn95', stopped: false })).toBe('warn95');
  });

  test('an exhausted budget runs on the fallback model until the gateway stops requests', () => {
    expect(getMultichamberBudgetMode({ state: 'exhausted', stopped: false })).toBe('fallback');
    expect(getMultichamberBudgetMode({ state: 'exhausted', stopped: true })).toBe('stopped');
  });

  test('an older gateway without the stop flag still means a stop', () => {
    expect(getMultichamberBudgetMode({ state: 'exhausted', stopped: null })).toBe('stopped');
  });

  test('the stop flag wins over a warning state', () => {
    expect(getMultichamberBudgetMode({ state: 'warn95', stopped: true })).toBe('stopped');
  });

  test('an own-key tariff has no budget to show', () => {
    expect(getMultichamberBudgetMode({ state: 'ok', stopped: false, byok: true })).toBe('hidden');
    expect(getMultichamberBudgetMode({ state: 'exhausted', stopped: true, byok: true })).toBe('hidden');
    expect(getMultichamberBudgetMode({ state: 'warn80', stopped: false, byok: false })).toBe('warn80');
  });
});

describe('getMultichamberBudgetResetKeys', () => {
  test('a subscription that does not renew says when the plan ends', () => {
    expect(getMultichamberBudgetResetKeys({ renews: false })).toEqual({
      resetsIn: 'multichamber.budget.endsIn',
      fallback: 'multichamber.budget.fallbackEnds',
      stopped: 'multichamber.budget.stoppedEnds',
    });
  });

  test('a renewing subscription and an older gateway keep the refresh texts', () => {
    const refresh = {
      resetsIn: 'multichamber.budget.resetsIn',
      fallback: 'multichamber.budget.fallback',
      stopped: 'multichamber.budget.stoppedUntil',
    };
    expect(getMultichamberBudgetResetKeys({ renews: true })).toEqual(refresh);
    expect(getMultichamberBudgetResetKeys({ renews: null })).toEqual(refresh);
  });
});

describe('formatBudgetResetDuration', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');

  test('counts days and hours', () => {
    expect(formatBudgetResetDuration(now + 2 * DAY + 4 * HOUR + 30 * MINUTE, now, 'ru-RU')).toBe('2 дня 4 ч');
    expect(formatBudgetResetDuration(now + DAY + 20 * MINUTE, now, 'en-US')).toBe('1 day');
  });

  test('counts hours and minutes on the last day', () => {
    expect(formatBudgetResetDuration(now + 4 * HOUR + 30 * MINUTE, now, 'en-US')).toBe('4 hr 30 min');
  });

  test('rounds the last minutes up', () => {
    expect(formatBudgetResetDuration(now + 4 * MINUTE + 10_000, now, 'ru-RU')).toBe('5 мин');
  });

  test('returns null once the reset time has passed', () => {
    expect(formatBudgetResetDuration(now, now, 'en-US')).toBeNull();
    expect(formatBudgetResetDuration(now - HOUR, now, 'en-US')).toBeNull();
  });
});
