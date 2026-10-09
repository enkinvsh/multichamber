import { describe, expect, test } from 'bun:test';

import { formatBudgetResetDuration, parseMultichamberBudget } from './budget';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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
    expect(parseMultichamberBudget(body)).toEqual({ state: 'exhausted', percent: 100, resetsAt: null });
  });

  test('keeps the indicator without a percent or a valid reset time', () => {
    expect(parseMultichamberBudget(JSON.stringify({ state: 'ok', resets_at: 'next week' }))).toEqual({
      state: 'ok',
      percent: null,
      resetsAt: null,
    });
  });

  test('rejects an unknown state and a body that is not JSON', () => {
    expect(() => parseMultichamberBudget(JSON.stringify({ state: 'maybe' }))).toThrow();
    expect(() => parseMultichamberBudget('<html>Bad gateway</html>')).toThrow();
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
