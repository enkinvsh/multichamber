import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installMultichamber, readMultichamberPolicy } from './install.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('readMultichamberPolicy', () => {
  it('reports lockdown and the fs root from the environment', () => {
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_FS_ROOT: ' /home/dev ' }))
      .toEqual({ lockdown: true, fsRoot: '/home/dev' });
  });

  it('reports no lockdown and no root when the variables are missing or blank', () => {
    expect(readMultichamberPolicy({})).toEqual({ lockdown: false, fsRoot: null });
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: 'true', MULTICHAMBER_FS_ROOT: '  ' }))
      .toEqual({ lockdown: false, fsRoot: null });
  });
});

describe('update checks in lockdown', () => {
  const appWith = (env) => {
    const app = express();
    installMultichamber(app, 'early', { env });
    app.get('/api/openchamber/update-check', (_req, res) => res.json({ available: true, from: 'upstream' }));
    app.get('/api/opencode/upgrade-status', (_req, res) => res.json({ available: true, from: 'upstream' }));
    return app;
  };

  it.each(['/api/openchamber/update-check?reportUsage=true', '/api/opencode/upgrade-status'])(
    'answers %s locally and contacts nobody',
    async (path) => {
      globalThis.fetch = vi.fn();
      const response = await request(appWith({ MULTICHAMBER_LOCKDOWN: '1' })).get(path);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ available: false });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it('leaves the stock routes in place without lockdown', async () => {
    const response = await request(appWith({})).get('/api/openchamber/update-check');
    expect(response.body).toEqual({ available: true, from: 'upstream' });
  });
});
