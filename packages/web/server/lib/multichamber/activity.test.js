import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MULTICHAMBER_ACTIVITY_ROUTE, registerMultichamberActivityRoute } from './activity.js';
import { installMultichamber } from './install.js';

const createApp = ({ enabled = true, now = () => Date.parse('2026-10-11T10:00:00.000Z') } = {}) => {
  const app = express();
  registerMultichamberActivityRoute(app, { enabled, now });
  return app;
};

describe('activity route', () => {
  it('reports no input before the first report', async () => {
    const response = await request(createApp()).get(MULTICHAMBER_ACTIVITY_ROUTE);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ last_input_at: null });
  });

  it('remembers the time of the latest input report', async () => {
    let clock = Date.parse('2026-10-11T10:00:00.000Z');
    const app = createApp({ now: () => clock });

    expect((await request(app).post(MULTICHAMBER_ACTIVITY_ROUTE)).status).toBe(204);
    clock += 90_000;
    expect((await request(app).post(MULTICHAMBER_ACTIVITY_ROUTE)).status).toBe(204);
    const response = await request(app).get(MULTICHAMBER_ACTIVITY_ROUTE);

    expect(response.body).toEqual({ last_input_at: '2026-10-11T10:01:30.000Z' });
  });

  it.each(['get', 'post'])('answers 404 to %s outside MultiChamber lockdown', async (method) => {
    const response = await request(createApp({ enabled: false }))[method](MULTICHAMBER_ACTIVITY_ROUTE);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'activity_not_enabled' });
  });

  it('is mounted by the early install stage only in lockdown', async () => {
    const appWith = (env) => {
      const app = express();
      installMultichamber(app, 'early', { env });
      return app;
    };

    expect((await request(appWith({ MULTICHAMBER_LOCKDOWN: '1' })).post(MULTICHAMBER_ACTIVITY_ROUTE)).status).toBe(204);
    expect((await request(appWith({})).post(MULTICHAMBER_ACTIVITY_ROUTE)).status).toBe(404);
  });
});
