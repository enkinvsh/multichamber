import { describe, expect, it } from 'vitest';

import { createLockdownGuard, createLockdownSettingsFilter, isLockdownEnabled, LOCKDOWN_DENIED_SETTINGS } from './lockdown-guard.js';

const LOCKED_BODY = { error: 'This setting is managed by MultiChamber.', code: 'multichamber_locked' };

const invoke = (middleware, request) => {
  const req = { headers: {}, ...request };
  const outcome = { nextCalled: false, status: null, body: null, req };
  const res = {
    status(code) {
      outcome.status = code;
      return res;
    },
    json(body) {
      outcome.body = body;
      return res;
    },
  };
  middleware(req, res, () => {
    outcome.nextCalled = true;
  });
  return outcome;
};

const run = (method, originalUrl) => invoke(createLockdownGuard({ enabled: true }), { method, originalUrl });

const expectAllowed = (method, url) => {
  const outcome = run(method, url);
  expect(outcome.status).toBeNull();
  expect(outcome.nextCalled).toBe(true);
};

const expectRefused = (method, url) => {
  const outcome = run(method, url);
  expect(outcome.nextCalled).toBe(false);
  expect(outcome.status).toBe(403);
  expect(outcome.body).toEqual(LOCKED_BODY);
};

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Groups where only writes are refused; GET, HEAD and OPTIONS on the same path stay allowed.
const WRITE_LOCKED = [
  '/api/provider',
  '/api/provider/openai/auth',
  '/api/auth/openai',
  '/api/auth/reset/extra',
  '/api/config',
  '/api/global/config',
  '/api/mcp',
  '/api/mcp/github/connect',
  '/api/mcp/github/disconnect',
  '/api/mcp/github/auth',
  '/api/mcp/github/auth/authenticate',
  '/api/mcp/auth/pending',
  '/api/config/mcp',
  '/api/config/mcp/github',
  '/api/config/plugins',
  '/api/config/plugins/entry/foo',
  '/api/behavior/agents-md',
  '/api/quota',
  '/api/quota/providers',
  '/api/openchamber/tunnel/start',
  '/api/openchamber/tunnel/status',
  '/api/openchamber/relay/enable',
  '/api/guests',
  '/api/guests/upload',
  '/api/guests/abc/files',
  '/api/routing',
  '/api/routing/token',
  '/api/client-auth/pairing/sessions',
  '/api/client-auth/clients/abc',
  '/api/passkeys/abc',
  '/api/linear/auth',
  '/api/linear/auth/start',
  '/api/linear/issues/update',
  '/api/github/auth',
  '/api/github/auth/start',
  '/api/github/auth/complete',
  '/api/github/auth/gh-cli',
  '/api/voice/token',
  '/api/tts/speak',
  '/api/dictation/models/whisper-small',
  '/api/experimental/console/switch',
  '/api/api/credential/abc',
  '/api/api/integration/openai/connect/key',
  '/api/credential/abc',
  '/api/integration/openai/connect/oauth',
];

// Groups refused for every method, reads included.
const ALL_LOCKED = [
  '/api/provider/openai/oauth/authorize',
  '/api/provider/openai/oauth/callback',
  '/api/global/upgrade',
  '/api/config/skills/install',
  '/api/config/skills/scan',
  '/api/quota/credentials/openai',
  '/api/quota/credentials/openai/import',
  '/api/openchamber/update-install',
  '/api/opencode/upgrade',
  '/api/system/shutdown',
  '/api/system/dev-shutdown',
  '/api/guests/abc/oauth/callback',
  '/api/guests/abc/oauth/start',
  '/auth/passkey/register/options',
  '/auth/passkey/register/verify',
  '/linear/oauth/callback',
  '/mcp/oauth/callback',
  '/api/dictation/models/whisper-small/download',
];

// Reads the UI needs at startup or polls, and writes next to locked groups that stay allowed.
const ALLOWED = [
  ['GET', '/api/provider'],
  ['GET', '/api/provider/auth'],
  ['GET', '/api/config'],
  ['GET', '/api/config/providers'],
  ['GET', '/api/mcp'],
  ['GET', '/api/config/mcp'],
  ['GET', '/api/config/plugins'],
  ['GET', '/api/config/skills'],
  ['GET', '/api/config/skills/catalog'],
  ['PUT', '/api/config/skills/my-skill'],
  ['DELETE', '/api/config/skills/my-skill'],
  ['PUT', '/api/config/agents/build'],
  ['PUT', '/api/config/commands/review'],
  ['POST', '/api/config/reload'],
  ['GET', '/api/behavior/agents-md'],
  ['GET', '/api/quota/providers'],
  ['GET', '/api/openchamber/tunnel/status'],
  ['GET', '/api/openchamber/relay/status'],
  ['GET', '/api/openchamber/update-check'],
  ['GET', '/api/opencode/upgrade-status'],
  ['POST', '/api/opencode/directory'],
  ['GET', '/api/system/info'],
  ['GET', '/api/system/free-port'],
  ['POST', '/api/system/probe-url'],
  ['GET', '/api/guests'],
  ['GET', '/api/routing'],
  ['GET', '/api/client-auth/clients'],
  ['GET', '/api/passkeys'],
  ['GET', '/api/linear/auth/status'],
  ['GET', '/api/github/auth/status'],
  ['GET', '/api/github/pr/status'],
  ['GET', '/api/tts/status'],
  ['GET', '/api/dictation/status'],
  ['GET', '/api/multichamber/policy'],
  ['POST', '/api/auth/reset'],
  ['GET', '/api/config/settings'],
  ['PUT', '/api/config/settings'],
  ['GET', '/api/session'],
  ['POST', '/api/session'],
  ['POST', '/api/session/abc/message'],
  ['POST', '/api/session/abc/prompt_async'],
  ['GET', '/api/fs/list'],
  ['POST', '/api/git/commit'],
  ['POST', '/api/terminal/create'],
  ['POST', '/api/providers-extra'],
  ['POST', '/api/quotas'],
  ['POST', '/api/configuration'],
  ['GET', '/auth/session'],
  ['POST', '/auth/session'],
  ['POST', '/auth/passkey/authenticate/options'],
  ['GET', '/auth/passkey/status'],
  ['GET', '/'],
  ['GET', '/assets/index.js'],
  ['POST', '/quota/providers'],
];

describe('createLockdownGuard', () => {
  it.each([undefined, false])('is off when enabled is %j', (enabled) => {
    expect(createLockdownGuard({ enabled })).toBeNull();
  });

  it('is off with no options', () => {
    expect(createLockdownGuard()).toBeNull();
  });

  describe.each(WRITES)('%s', (method) => {
    it.each(WRITE_LOCKED)('refuses %s', (path) => {
      expectRefused(method, path);
    });

    it.each(ALL_LOCKED)('refuses %s', (path) => {
      expectRefused(method, path);
    });
  });

  it.each(WRITE_LOCKED)('allows GET, HEAD and OPTIONS on %s', (path) => {
    expectAllowed('GET', path);
    expectAllowed('HEAD', path);
    expectAllowed('OPTIONS', path);
  });

  it.each(ALL_LOCKED)('refuses GET on %s', (path) => {
    expectRefused('GET', path);
    expectRefused('HEAD', path);
    expectRefused('OPTIONS', path);
  });

  it.each(ALLOWED)('allows %s %s', (method, path) => {
    expectAllowed(method, path);
  });

  it('treats lowercase methods like uppercase', () => {
    expectRefused('put', '/api/provider');
  });

  it('keeps only POST /api/auth/reset open under /api/auth', () => {
    expectAllowed('POST', '/api/auth/reset');
    expectAllowed('POST', '/API/Auth/Reset/');
    expectRefused('PUT', '/api/auth/reset');
    expectRefused('DELETE', '/api/auth/reset');
  });

  it('leaves OpenChamber config writes below /api/config open while PATCH /api/config is refused', () => {
    expectRefused('PATCH', '/api/config');
    expectAllowed('PATCH', '/api/config/settings');
    expectAllowed('POST', '/api/config/snippets');
  });

  it.each([
    ['PUT', '/API/Provider'],
    ['GET', '/API/Quota/Credentials/openai'],
    ['POST', '/Api/OpenChamber/Tunnel/Start'],
    ['POST', '/AUTH/Passkey/Register/Options'],
    ['PATCH', '/api/CONFIG'],
    ['PUT', '/api/Auth/openai'],
  ])('refuses case variant %s %s', (method, path) => {
    expectRefused(method, path);
  });

  it.each([
    ['PUT', '/api/provider/'],
    ['GET', '/api/quota/credentials/openai/'],
    ['POST', '/api/mcp/'],
    ['PATCH', '/api/config/'],
  ])('refuses trailing slash %s %s', (method, path) => {
    expectRefused(method, path);
  });

  it.each([
    ['PUT', '//api/provider'],
    ['GET', '/api//quota//credentials//openai'],
    ['POST', '/api/mcp//'],
    ['POST', '\\api\\mcp'],
  ])('refuses doubled or backslash separators %s %s', (method, path) => {
    expectRefused(method, path);
  });

  it.each([
    ['PUT', '/api/%70rovider'],
    ['GET', '/api/%71uota/credentials/openai'],
    ['GET', '/%61pi/quota/credentials/openai'],
    ['POST', '/api/mcp%2Fgithub%2Fconnect'],
    ['GET', '/api%2Fquota%2Fcredentials%2Fopenai'],
    ['POST', '/auth/passkey/register%2Foptions'],
    ['PUT', '/api/auth%2Fopenai'],
  ])('refuses percent-encoded %s %s', (method, path) => {
    expectRefused(method, path);
  });

  it.each([
    ['GET', '/api/session/./abc'],
    ['GET', '/api/config/../provider'],
    ['GET', '/api/%2e%2e/quota'],
    ['GET', '/api/fs/%2E/list'],
    ['GET', '/auth/../api/quota'],
    ['GET', '/api/%E0%A4%A'],
    ['GET', '/API/%zz'],
    ['GET', '/api/session%2F..%2Fquota'],
  ])('refuses unreadable or dot-segment API paths %s %s', (method, path) => {
    expectRefused(method, path);
  });

  it('passes unreadable paths outside /api and /auth through', () => {
    expectAllowed('GET', '/assets/%E0%A4%A');
    expectAllowed('GET', '/assets/../index.html');
  });

  it('ignores the query string', () => {
    expectAllowed('GET', '/api/provider?x=/api/quota/credentials');
    expectRefused('GET', '/api/quota/credentials/openai?directory=/home/dev');
    expectRefused('PUT', '/api/provider;x');
  });

  it('falls back to req.url when originalUrl is missing', () => {
    const outcome = invoke(createLockdownGuard({ enabled: true }), { method: 'GET', url: '/api/quota/credentials/openai' });
    expect(outcome.status).toBe(403);
  });

  it('refuses sharing and unsharing a session but keeps session reads and other session writes', () => {
    for (const url of ['/api/session/ses_1/share', '/api/api/session/ses_1/share', '/api/session/ses_1/share?directory=/home/dev/p']) {
      expectRefused('POST', url);
      expectRefused('DELETE', url);
      expectAllowed('GET', url);
    }
    expectAllowed('GET', '/api/session/ses_1');
    expectAllowed('POST', '/api/session/ses_1/message');
    expectAllowed('POST', '/api/session/ses_1/prompt_async');
    expectAllowed('DELETE', '/api/session/ses_1');
  });
});

describe('createLockdownSettingsFilter', () => {
  const filter = (request) => invoke(createLockdownSettingsFilter({ enabled: true }), request);

  it.each([undefined, false])('is off when enabled is %j', (enabled) => {
    expect(createLockdownSettingsFilter({ enabled })).toBeNull();
  });

  it('denies the instance keys that change the host, the network or credentials', () => {
    expect(LOCKDOWN_DENIED_SETTINGS).toEqual(expect.arrayContaining([
      'opencodeBinary',
      'homeDirectory',
      'desktopLanAccessEnabled',
      'desktopUiPassword',
      'githubClientId',
      'githubScopes',
      'skillCatalogs',
      'sttProvider',
      'sttServerUrl',
      'tunnelProvider',
      'tunnelMode',
      'tunnelBootstrapTtlMs',
      'tunnelSessionTtlMs',
      'managedLocalTunnelConfigPath',
      'managedRemoteTunnelHostname',
      'managedRemoteTunnelToken',
      'managedRemoteTunnelPresets',
      'managedRemoteTunnelSelectedPresetId',
      'managedRemoteTunnelPresetTokens',
      'desktopHosts',
      'desktopDefaultHostId',
      'desktopSshInstances',
      'terminalShell',
      'securityScopedBookmarks',
      'routingFeatureAvailable',
    ]));
  });

  it('keeps per-user preferences', () => {
    for (const key of ['themeId', 'lastDirectory', 'projects', 'permissionAutoAccept', 'autoDeleteEnabled', 'agentMemoryToolEnabled']) {
      expect(LOCKDOWN_DENIED_SETTINGS).not.toContain(key);
    }
  });

  it('strips denied keys from a settings write and keeps the rest', () => {
    const body = { themeId: 'dark', opencodeBinary: '/tmp/evil', tunnelMode: 'quick', lastDirectory: '/home/dev/p' };
    const outcome = filter({ method: 'PUT', originalUrl: '/api/config/settings', body });
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.status).toBeNull();
    expect(outcome.req.body).toEqual({ themeId: 'dark', lastDirectory: '/home/dev/p' });
  });

  it.each(['PATCH', 'POST'])('strips on %s too', (method) => {
    const outcome = filter({ method, originalUrl: '/api/config/settings', body: { sttServerUrl: 'http://x' } });
    expect(outcome.req.body).toEqual({});
  });

  it.each(['/API/Config/Settings', '/api/config/settings/', '//api//config//settings', '/api/config/%73ettings'])(
    'strips on path variant %s',
    (originalUrl) => {
      const outcome = filter({ method: 'PUT', originalUrl, body: { homeDirectory: '/' } });
      expect(outcome.req.body).toEqual({});
    },
  );

  it('leaves other routes and reads untouched', () => {
    expect(filter({ method: 'PUT', originalUrl: '/api/config/other', body: { opencodeBinary: 'x' } }).req.body)
      .toEqual({ opencodeBinary: 'x' });
    expect(filter({ method: 'GET', originalUrl: '/api/config/settings', body: { opencodeBinary: 'x' } }).req.body)
      .toEqual({ opencodeBinary: 'x' });
  });

  it('passes requests without an object body through', () => {
    const outcome = filter({ method: 'PUT', originalUrl: '/api/config/settings', body: undefined });
    expect(outcome.nextCalled).toBe(true);
  });
});

describe('isLockdownEnabled', () => {
  it('is on only for MULTICHAMBER_LOCKDOWN=1', () => {
    expect(isLockdownEnabled({ MULTICHAMBER_LOCKDOWN: '1' })).toBe(true);
    expect(isLockdownEnabled({ MULTICHAMBER_LOCKDOWN: 'true' })).toBe(false);
    expect(isLockdownEnabled({ MULTICHAMBER_LOCKDOWN: '0' })).toBe(false);
    expect(isLockdownEnabled({})).toBe(false);
  });
});
