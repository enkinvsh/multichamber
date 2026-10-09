import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MULTICHAMBER_BUDGET_ROUTE, registerMultichamberBudgetRoute } from './budget.js';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const createLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
};

const createApp = ({ budgetUrl = 'https://budget.test/weekly?token=secret', fetchImpl, logger = createLogger() }) => {
  const app = express();
  registerMultichamberBudgetRoute(app, { budgetUrl, fetchImpl, logger });
  return app;
};

describe('budget route', () => {
  it('answers 404 when no budget URL is configured', async () => {
    const response = await request(createApp({ budgetUrl: null })).get(MULTICHAMBER_BUDGET_ROUTE);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'budget_not_configured' });
  });

  it('normalises the upstream payload and clamps overdrawn percents', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), accept: init.headers.accept });
      return jsonResponse({ state: 'exhausted', weekly_percent_used: 112.5, resets_at: '2026-10-12T00:00:00+03:00', pack_percent_used: -4 });
    };

    const response = await request(createApp({ fetchImpl })).get(MULTICHAMBER_BUDGET_ROUTE);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      state: 'exhausted',
      weekly_percent_used: 100,
      resets_at: '2026-10-11T21:00:00.000Z',
      pack_percent_used: 0,
      has_topup: false,
    });
    expect(calls).toEqual([{ url: 'https://budget.test/weekly?token=secret', accept: 'application/json' }]);
  });

  it('reuses a fresh answer for a few seconds only', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ state: 'ok', weekly_percent_used: calls, resets_at: null, pack_percent_used: null, has_topup: true });
    };
    const app = createApp({ fetchImpl });

    await request(app).get(MULTICHAMBER_BUDGET_ROUTE);
    const cached = await request(app).get(MULTICHAMBER_BUDGET_ROUTE);

    expect(calls).toBe(1);
    expect(cached.body.weekly_percent_used).toBe(1);
  });

  it.each([
    ['an error status', async () => jsonResponse({ error: 'down' }, 503)],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
    ['an unknown state', async () => jsonResponse({ state: 'maybe' })],
    ['a network failure', async () => {
      throw new TypeError('fetch failed');
    }],
  ])('answers 502 for %s without leaking the upstream URL', async (_label, fetchImpl) => {
    const logger = createLogger();

    const response = await request(createApp({ fetchImpl, logger })).get(MULTICHAMBER_BUDGET_ROUTE);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'budget_unavailable' });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).not.toContain('secret');
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 500);
      return jsonResponse({ state: 'warn80', weekly_percent_used: 81, resets_at: null, pack_percent_used: null, has_topup: false });
    };
    const app = createApp({ fetchImpl });

    expect((await request(app).get(MULTICHAMBER_BUDGET_ROUTE)).status).toBe(502);
    const recovered = await request(app).get(MULTICHAMBER_BUDGET_ROUTE);

    expect(recovered.status).toBe(200);
    expect(recovered.body.state).toBe('warn80');
  });
});
