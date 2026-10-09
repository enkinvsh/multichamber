/**
 * `GET /api/multichamber/budget`: server-side proxy to the operator's budget
 * endpoint (`MULTICHAMBER_BUDGET_URL`). The browser never sees that URL.
 * Upstream failure of any kind answers 502 so the UI can hide the budget
 * instead of showing a stale or empty one. Without the variable the route
 * answers 404 and the UI shows no budget at all.
 */
import { z } from 'zod';

export const MULTICHAMBER_BUDGET_ROUTE = '/api/multichamber/budget';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_CHARS = 64 * 1024;
const FAILURE_LOG_INTERVAL_MS = 60_000;
// Long enough to absorb a burst of tabs and focus events, short enough that a top-up shows within seconds.
const SUCCESS_CACHE_MS = 3_000;

const percentSchema = z.number().nullish().transform((value) => (value == null ? null : Math.min(100, Math.max(0, value))));
const resetsAtSchema = z.string().nullish().transform((value, context) => {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    context.addIssue({ code: 'custom', message: 'resets_at is not a date' });
    return z.NEVER;
  }
  return new Date(timestamp).toISOString();
});

/** The operator contract; percents are clamped to 0..100 and `resets_at` normalised to ISO UTC. */
const budgetPayloadSchema = z.object({
  state: z.enum(['ok', 'warn80', 'warn95', 'exhausted']),
  weekly_percent_used: percentSchema,
  resets_at: resetsAtSchema,
  pack_percent_used: percentSchema,
  has_topup: z.boolean().default(false),
});

class BudgetUpstreamError extends Error {}

/** @param {Error | string | null | undefined} error */
const describeError = (error) => {
  if (error instanceof z.ZodError) return 'invalid payload';
  if (error instanceof SyntaxError) return 'response is not JSON';
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
  return String(error);
};

/**
 * @param {{
 *   budgetUrl: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   logger?: Pick<Console, 'warn'>,
 *   now?: () => number,
 * }} options
 * @returns {import('express').RequestHandler}
 */
const createMultichamberBudgetHandler = ({
  budgetUrl,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
  now = Date.now,
}) => {
  /** @type {Promise<z.infer<typeof budgetPayloadSchema>> | null} */
  let inFlight = null;
  /** @type {{ payload: z.infer<typeof budgetPayloadSchema>, at: number } | null} */
  let cached = null;
  let lastFailureLogAt = Number.NEGATIVE_INFINITY;

  const load = async () => {
    const response = await fetchImpl(budgetUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new BudgetUpstreamError(`upstream answered ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_BODY_CHARS) throw new BudgetUpstreamError('response is too large');
    const payload = budgetPayloadSchema.parse(JSON.parse(body));
    cached = { payload, at: now() };
    return payload;
  };

  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (cached && now() - cached.at < SUCCESS_CACHE_MS) {
      res.json(cached.payload);
      return;
    }
    // Only successes are cached: after a failure the next poll asks upstream again.
    cached = null;
    // Tabs poll independently; concurrent requests share one upstream call.
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    try {
      res.json(await inFlight);
    } catch (error) {
      if (now() - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
        lastFailureLogAt = now();
        logger.warn(`[multichamber] budget unavailable: ${describeError(error)}`);
      }
      res.status(502).json({ error: 'budget_unavailable' });
    }
  };
};

/**
 * Always registers the route so an unconfigured budget answers 404 here
 * instead of falling through to the OpenCode proxy.
 * @param {import('express').Express} app
 * @param {{ budgetUrl: string | null, fetchImpl?: typeof fetch, logger?: Pick<Console, 'warn'> }} options
 */
export const registerMultichamberBudgetRoute = (app, { budgetUrl, fetchImpl, logger }) => {
  if (!budgetUrl) {
    app.get(MULTICHAMBER_BUDGET_ROUTE, (_req, res) => {
      res.status(404).json({ error: 'budget_not_configured' });
    });
    return;
  }
  app.get(MULTICHAMBER_BUDGET_ROUTE, createMultichamberBudgetHandler({ budgetUrl, fetchImpl, logger }));
};
