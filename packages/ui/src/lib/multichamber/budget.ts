/**
 * MultiChamber budget indicator. `GET /api/multichamber/budget` proxies the
 * operator's budget endpoint (`packages/web/server/lib/multichamber/budget.js`):
 * 404 when it is not configured, 502 when the upstream fails. The UI asks only
 * when the inlined brand config announces a budget, every minute while the
 * page is visible and again whenever the window regains focus.
 *
 * Any failure clears the budget, so the indicator disappears instead of
 * showing a stale or guessed value.
 */
import React from 'react';
import { z } from 'zod';
import { create } from 'zustand';
import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getMultichamberBrand } from './brand';

const POLL_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const percentSchema = z
  .number()
  .nullish()
  .transform((value) => (value == null ? null : Math.min(100, Math.max(0, value))));

const budgetStateSchema = z.enum(['ok', 'warn80', 'warn95', 'exhausted']);

export type MultichamberBudgetState = z.infer<typeof budgetStateSchema>;

export type MultichamberBudget = {
  state: MultichamberBudgetState;
  /** Weekly percent used, else the top-up pack's; whole number in 0..100. */
  percent: number | null;
  /** Epoch milliseconds of the next weekly reset. */
  resetsAt: number | null;
};

const budgetSchema = z
  .object({
    state: budgetStateSchema,
    weekly_percent_used: percentSchema,
    pack_percent_used: percentSchema,
    // A broken date only drops the countdown, not the whole indicator.
    resets_at: z.iso.datetime({ offset: true }).nullish().catch(null),
  })
  .transform((payload): MultichamberBudget => {
    const percent = payload.weekly_percent_used ?? payload.pack_percent_used;
    return {
      state: payload.state,
      percent: percent === null ? null : Math.floor(percent),
      resetsAt: payload.resets_at ? Date.parse(payload.resets_at) : null,
    };
  });

type BudgetStore = {
  budget: MultichamberBudget | null;
};

const useBudgetStore = create<BudgetStore>(() => ({ budget: null }));

/** Parses a `/api/multichamber/budget` body; throws on anything that is not a budget. */
export const parseMultichamberBudget = (body: string): MultichamberBudget => budgetSchema.parse(JSON.parse(body));

const fetchBudget = async (): Promise<MultichamberBudget> => {
  const response = await runtimeFetch('/api/multichamber/budget', { cache: 'no-store' });
  if (!response.ok) throw new Error(`budget request failed (${response.status})`);
  return parseMultichamberBudget(await response.text());
};

let inFlightRefresh: Promise<void> | null = null;
let failureLogged = false;

/** Concurrent callers (focus and visibility events fire together) share one request. */
const refreshBudget = (): Promise<void> => {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = fetchBudget()
    .then((budget) => {
      failureLogged = false;
      useBudgetStore.setState({ budget });
    })
    .catch((error: Error) => {
      if (!failureLogged) {
        failureLogged = true;
        console.warn('[multichamber] budget unavailable:', error.message);
      }
      useBudgetStore.setState({ budget: null });
    })
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
};

const startPolling = (): (() => void) => {
  const refreshIfVisible = () => {
    if (document.visibilityState !== 'hidden') void refreshBudget();
  };
  const timer = window.setInterval(refreshIfVisible, POLL_INTERVAL_MS);
  window.addEventListener('focus', refreshIfVisible);
  document.addEventListener('visibilitychange', refreshIfVisible);
  void refreshBudget();
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', refreshIfVisible);
    document.removeEventListener('visibilitychange', refreshIfVisible);
  };
};

let subscriberCount = 0;
let stopPolling: (() => void) | null = null;

/** Several components show the budget; they share one poller. */
const subscribeBudget = (): (() => void) => {
  subscriberCount += 1;
  if (subscriberCount === 1) stopPolling = startPolling();
  return () => {
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      stopPolling?.();
      stopPolling = null;
    }
  };
};

/** The budget to show, or null: not configured, not loaded yet, or unavailable. */
export const useMultichamberBudget = (): MultichamberBudget | null => {
  const enabled = getMultichamberBrand()?.budget === true;
  React.useEffect(() => (enabled ? subscribeBudget() : undefined), [enabled]);
  const budget = useBudgetStore((state) => state.budget);
  return enabled ? budget : null;
};

/**
 * Countdown to the reset in the user's language ("2 дня 4 ч", "4 hr 30 min"),
 * or null once the reset time has passed.
 */
export const formatBudgetResetDuration = (resetsAt: number, now: number, locale: string): string | null => {
  const remaining = resetsAt - now;
  if (!(remaining > 0)) return null;
  const format = (value: number, unit: 'day' | 'hour' | 'minute', unitDisplay: 'long' | 'short') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay }).format(value);
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  const parts =
    days > 0
      ? [format(days, 'day', 'long'), ...(hours > 0 ? [format(hours, 'hour', 'short')] : [])]
      : hours > 0
        ? [format(hours, 'hour', 'short'), ...(minutes > 0 ? [format(minutes, 'minute', 'short')] : [])]
        : [format(Math.max(1, Math.ceil(remaining / MINUTE_MS)), 'minute', 'short')];
  return new Intl.ListFormat(locale, { type: 'unit', style: 'narrow' }).format(parts);
};

/** "Сброс через 2 дня 4 ч" in the UI language, or null when the reset time is unknown or past. */
export const useMultichamberBudgetResetLabel = (budget: MultichamberBudget): string | null => {
  const { t } = useI18n();
  if (budget.resetsAt === null) return null;
  const duration = formatBudgetResetDuration(budget.resetsAt, Date.now(), getCurrentIntlLocale());
  return duration ? t('multichamber.budget.resetsIn', { duration }) : null;
};
