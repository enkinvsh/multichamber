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
      .toEqual({ lockdown: true, fsRoot: '/home/dev', previewOpenUrl: null, dictation: false, ownClaude: false });
  });

  it('reports no lockdown and no root when the variables are missing or blank', () => {
    expect(readMultichamberPolicy({})).toEqual({ lockdown: false, fsRoot: null, previewOpenUrl: null, dictation: false, ownClaude: false });
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: 'true', MULTICHAMBER_FS_ROOT: '  ' }))
      .toEqual({ lockdown: false, fsRoot: null, previewOpenUrl: null, dictation: false, ownClaude: false });
  });

  it('reports own Claude only when MULTICHAMBER_OWN_CLAUDE is exactly 1', () => {
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_OWN_CLAUDE: '1' }).ownClaude).toBe(true);
    for (const value of ['0', 'true', ' 1', '', undefined]) {
      expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_OWN_CLAUDE: value }).ownClaude).toBe(false);
    }
  });

  it('reports dictation only when a valid managed STT endpoint is configured', () => {
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_STT_BASE_URL: 'http://10.88.0.1:8317/v1' }).dictation).toBe(true);
    expect(readMultichamberPolicy({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_STT_BASE_URL: 'ftp://10.88.0.1/v1' }).dictation).toBe(false);
  });

  it('reports the preview open url only for an absolute https url', () => {
    expect(readMultichamberPolicy({ MULTICHAMBER_PREVIEW_OPEN_URL: ' https://ai.example.test/api/preview/open ' }).previewOpenUrl)
      .toBe('https://ai.example.test/api/preview/open');
    for (const value of ['http://ai.example.test/open', 'javascript:alert(1)', '/api/preview/open', 'https://', 'https://user:pw@ai.example.test/open', '']) {
      expect(readMultichamberPolicy({ MULTICHAMBER_PREVIEW_OPEN_URL: value }).previewOpenUrl).toBeNull();
    }
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

describe('policy route', () => {
  const policyOf = async (env) => {
    const app = express();
    installMultichamber(app, 'early', { env });
    return (await request(app).get('/api/multichamber/policy')).body;
  };

  it('reports dictation when managed STT is configured', async () => {
    expect((await policyOf({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_STT_BASE_URL: 'http://10.88.0.1:8317/v1' })).dictation).toBe(true);
  });

  it('reports no dictation without managed STT', async () => {
    expect((await policyOf({ MULTICHAMBER_LOCKDOWN: '1' })).dictation).toBe(false);
  });

  it('reports own Claude when the slot runs on the owner subscription', async () => {
    expect((await policyOf({ MULTICHAMBER_LOCKDOWN: '1', MULTICHAMBER_OWN_CLAUDE: '1' })).ownClaude).toBe(true);
    expect((await policyOf({ MULTICHAMBER_LOCKDOWN: '1' })).ownClaude).toBe(false);
  });
});
