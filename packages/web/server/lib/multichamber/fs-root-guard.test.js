import { describe, expect, it } from 'vitest';

import { createFsRootGuard } from './fs-root-guard.js';

const ROOT = '/home/dev';

const run = (request, root = ROOT) => {
  const guard = createFsRootGuard({ root, homedir: ROOT });
  const req = { headers: {}, ...request };
  const outcome = { nextCalled: false, status: null, body: null };
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
  guard(req, res, () => {
    outcome.nextCalled = true;
  });
  return outcome;
};

const expectAllowed = (request) => {
  const outcome = run(request);
  expect(outcome.status).toBeNull();
  expect(outcome.nextCalled).toBe(true);
};

const expectRefused = (request) => {
  const outcome = run(request);
  expect(outcome.nextCalled).toBe(false);
  expect(outcome.status).toBe(403);
  expect(outcome.body).toEqual({ error: 'Path is outside the allowed folder.', code: 'outside_fs_root' });
};

describe('createFsRootGuard', () => {
  it.each([undefined, '', '   '])('is off when the root is %j', (root) => {
    expect(createFsRootGuard({ root, homedir: ROOT })).toBeNull();
  });

  it('passes non-API requests through', () => {
    expectAllowed({ originalUrl: '/index.html?directory=/etc' });
  });

  it('refuses a folder listing outside the root', () => {
    expectRefused({ originalUrl: '/api/fs/list?path=/etc' });
  });

  it('allows a folder listing inside the root', () => {
    expectAllowed({ originalUrl: '/api/fs/list?path=/home/dev/projects' });
  });

  it('allows a folder listing without a path', () => {
    expectAllowed({ originalUrl: '/api/fs/list' });
  });

  it.each(['~/x', '~'])('expands %s to the home folder', (value) => {
    expectAllowed({ originalUrl: `/api/fs/list?path=${encodeURIComponent(value)}` });
  });

  it('refuses a sibling folder sharing the root prefix', () => {
    expectRefused({ originalUrl: '/api/fs/list?path=/home/dev2' });
  });

  it('refuses a path escaping the root through ..', () => {
    expectRefused({ originalUrl: '/api/fs/list?path=/home/dev/../etc' });
  });

  it('refuses a directory query outside the root', () => {
    expectRefused({ originalUrl: '/api/session?directory=/tmp' });
  });

  it('refuses a location[directory] query outside the root', () => {
    expectRefused({ originalUrl: '/api/session?location%5Bdirectory%5D=/etc' });
  });

  it('decodes a percent-escaped directory header', () => {
    expectRefused({ originalUrl: '/api/session', headers: { 'x-opencode-directory': '%2Fetc' } });
  });

  it('allows a directory header inside the root', () => {
    expectAllowed({ originalUrl: '/api/session', headers: { 'x-opencode-directory': '/home/dev/p' } });
  });

  it('leaves a relative path on a proxied route alone', () => {
    expectAllowed({ originalUrl: '/api/file?path=src/index.ts' });
  });

  it('refuses an absolute path on a proxied route outside the root', () => {
    expectRefused({ originalUrl: '/api/file?path=/etc/passwd' });
  });

  it('refuses a rename whose target is outside the root', () => {
    expectRefused({ originalUrl: '/api/fs/rename', body: { oldPath: '/home/dev/a', newPath: '/etc/a' } });
  });

  it('refuses a command run from outside the root', () => {
    expectRefused({ originalUrl: '/api/fs/exec', body: { cwd: '/' } });
  });

  it('matches the route case-insensitively', () => {
    expectRefused({ originalUrl: '/API/FS/list?path=/etc' });
  });

  it('allows a project path inside the root', () => {
    expectAllowed({ originalUrl: '/api/projects/p1/config', body: { projectPath: '/home/dev/app' } });
  });

  it('refuses a project path outside the root', () => {
    expectRefused({ originalUrl: '/api/projects/p1/config', body: { projectPath: '/srv/app' } });
  });

  it('refuses opening a project directory outside the root', () => {
    expectRefused({ originalUrl: '/api/opencode/directory', body: { path: '/' } });
  });

  it('allows opening a project directory inside the root', () => {
    expectAllowed({ originalUrl: '/api/opencode/directory', body: { path: '/home/dev/app' } });
  });

  it('decodes a uri-encoded directory header', () => {
    expectRefused({
      originalUrl: '/api/session',
      headers: { 'x-opencode-directory': '%2Fsrv%2Fapp', 'x-opencode-directory-encoding': 'uri' },
    });
  });

  it('refuses an OpenCode v2 file listing outside the root', () => {
    expectRefused({ originalUrl: '/api/api/fs/list?path=/etc&location%5Bdirectory%5D=/home/dev' });
    expectRefused({ originalUrl: '/api/api/fs/list?path=src&location%5Bdirectory%5D=/etc' });
  });

  it.each([
    ['/api/fs/mkdir', { path: '/opt/x' }],
    ['/api/fs/write', { path: '/etc/hosts', content: 'x' }],
    ['/api/fs/delete', { path: '/opt/multichamber' }],
    ['/api/fs/clone', { remoteUrl: 'https://x', destinationPath: '/tmp/x' }],
  ])('refuses %s outside the root', (originalUrl, body) => {
    expectRefused({ originalUrl, body });
  });

  it('refuses an upload outside the root', () => {
    expectRefused({ originalUrl: '/api/fs/upload?path=/tmp/x' });
  });

  it('treats a root of / as containing everything', () => {
    const outcome = run({ originalUrl: '/api/fs/list?path=/etc' }, '/');
    expect(outcome.nextCalled).toBe(true);
  });
});
