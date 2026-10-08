import { describe, expect, it } from 'vitest';

import { createLockdownProjectGuard, ensureGitRepository, isAllowedProjectPath } from './project-guard.js';

const HOME = '/home/dev';
const LOCKED_BODY = { error: 'This folder cannot be a project.', code: 'multichamber_locked' };

const createGit = ({ repos = [] } = {}) => {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    const directory = args[1];
    if (args[2] === 'rev-parse') {
      const inside = repos.some((repo) => directory === repo || directory.startsWith(`${repo}/`));
      return inside ? { ok: true, stdout: 'true\n', stderr: '' } : { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
    }
    return { ok: true, stdout: 'Initialized empty Git repository', stderr: '' };
  };
  return { calls, runGit };
};

const createLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
};

const createGuard = (overrides = {}) => createLockdownProjectGuard({
  enabled: true,
  root: HOME,
  homedir: HOME,
  dataHomeDir: '',
  realpath: async (value) => value,
  runGit: createGit().runGit,
  logger: createLogger(),
  ...overrides,
});

const invoke = async (middleware, request, respond) => {
  const req = { headers: {}, ...request };
  const outcome = { nextCalled: false, status: null, body: null, req, sent: null };
  let resolveSent;
  const sent = new Promise((resolve) => { resolveSent = resolve; });
  const res = {
    statusCode: 200,
    status(code) {
      res.statusCode = code;
      outcome.status = code;
      return res;
    },
    json(body) {
      outcome.body = body;
      resolveSent(body);
      return res;
    },
  };
  await new Promise((resolve) => {
    middleware(req, res, (error) => {
      outcome.nextCalled = error === undefined;
      resolve();
    });
    sent.then(resolve);
  });
  if (outcome.nextCalled && respond) {
    respond(res);
    await sent;
  }
  return outcome;
};

describe('isAllowedProjectPath', () => {
  it('refuses the root, paths outside it and hidden segments below it', () => {
    expect(isAllowedProjectPath(HOME, HOME)).toBe(false);
    expect(isAllowedProjectPath('/home', HOME)).toBe(false);
    expect(isAllowedProjectPath('/etc', HOME)).toBe(false);
    expect(isAllowedProjectPath('/home/dev2/p', HOME)).toBe(false);
    expect(isAllowedProjectPath('/home/dev/.omo', HOME)).toBe(false);
    expect(isAllowedProjectPath('/home/dev/.config/opencode', HOME)).toBe(false);
    expect(isAllowedProjectPath('/home/dev/projects/app/.git', HOME)).toBe(false);
    expect(isAllowedProjectPath('/home/dev/projects/app', HOME)).toBe(true);
    expect(isAllowedProjectPath('/home/dev/projects/my.app', HOME)).toBe(true);
    expect(isAllowedProjectPath('/home/dev/..foo', HOME)).toBe(false);
  });
});

describe('ensureGitRepository', () => {
  it('leaves an existing work tree alone', async () => {
    const git = createGit({ repos: ['/home/dev/projects/app'] });
    expect(await ensureGitRepository('/home/dev/projects/app/sub', { runGit: git.runGit })).toBe('existing');
    expect(git.calls).toEqual([['-C', '/home/dev/projects/app/sub', 'rev-parse', '--is-inside-work-tree']]);
  });

  it('runs git init without a commit when the folder is not a repository', async () => {
    const git = createGit();
    expect(await ensureGitRepository('/home/dev/projects/new', { runGit: git.runGit })).toBe('initialized');
    expect(git.calls.at(-1)).toEqual(['-C', '/home/dev/projects/new', 'init']);
    expect(git.calls.some((args) => args.includes('commit'))).toBe(false);
  });

  it('logs a warning instead of throwing when git init fails', async () => {
    const logger = createLogger();
    const runGit = async (args) => (args[2] === 'init'
      ? { ok: false, stdout: '', stderr: 'permission denied' }
      : { ok: false, stdout: '', stderr: 'fatal' });
    expect(await ensureGitRepository('/home/dev/projects/ro', { runGit, logger })).toBe('failed');
    expect(logger.warnings).toEqual(['[multichamber] git init failed in /home/dev/projects/ro: permission denied']);
  });
});

describe('createLockdownProjectGuard: POST /api/opencode/directory', () => {
  const post = (guard, path, respond) => invoke(guard, { method: 'POST', originalUrl: '/api/opencode/directory', body: { path, create: true } }, respond);

  it('is off when lockdown is off', () => {
    expect(createLockdownProjectGuard({ enabled: false, root: HOME })).toBeNull();
  });

  it.each([HOME, '~', '~/', '/home/dev/.omo', '~/.config/opencode', '/home/dev/.local/share/x', '/home/dev/projects/.hidden', '/tmp/x'])(
    'refuses %s',
    async (path) => {
      const outcome = await post(createGuard(), path);
      expect(outcome.nextCalled).toBe(false);
      expect(outcome.status).toBe(403);
      expect(outcome.body).toEqual(LOCKED_BODY);
    },
  );

  it('refuses a symlink that resolves into a hidden folder', async () => {
    const realpath = async (value) => (value === '/home/dev/projects/link' ? '/home/dev/.omo' : value);
    const outcome = await post(createGuard({ realpath }), '/home/dev/projects/link');
    expect(outcome.status).toBe(403);
  });

  it('lets a blank path reach the route for its own 400', async () => {
    const outcome = await post(createGuard(), '  ');
    expect(outcome.nextCalled).toBe(true);
  });

  it('runs git init before the route answers a new project', async () => {
    const git = createGit();
    const guard = createGuard({ runGit: git.runGit });
    const outcome = await post(guard, '~/projects/new', (res) => {
      expect(git.calls).toEqual([]);
      res.json({ success: true, path: '/home/dev/projects/new' });
    });
    expect(outcome.body).toEqual({ success: true, path: '/home/dev/projects/new' });
    expect(git.calls).toEqual([
      ['-C', '/home/dev/projects/new', 'rev-parse', '--is-inside-work-tree'],
      ['-C', '/home/dev/projects/new', 'init'],
    ]);
  });

  it('skips git when the route fails', async () => {
    const git = createGit();
    const outcome = await post(createGuard({ runGit: git.runGit }), '/home/dev/projects/new', (res) => {
      res.status(400).json({ error: 'Directory not found' });
    });
    expect(outcome.status).toBe(400);
    expect(git.calls).toEqual([]);
  });

  it('answers even when git init fails', async () => {
    const logger = createLogger();
    const runGit = async () => ({ ok: false, stdout: '', stderr: 'boom' });
    const outcome = await post(createGuard({ runGit, logger }), '/home/dev/projects/new', (res) => {
      res.json({ success: true, path: '/home/dev/projects/new' });
    });
    expect(outcome.body).toEqual({ success: true, path: '/home/dev/projects/new' });
    expect(logger.warnings).toHaveLength(1);
  });

  it('checks each directory once per process', async () => {
    const git = createGit({ repos: ['/home/dev/projects/app'] });
    const guard = createGuard({ runGit: git.runGit });
    const answer = (res) => res.json({ success: true, path: '/home/dev/projects/app' });
    await post(guard, '/home/dev/projects/app', answer);
    await post(guard, '/home/dev/projects/app', answer);
    expect(git.calls).toHaveLength(1);
  });
});

describe('createLockdownProjectGuard: PUT /api/config/settings', () => {
  const put = (guard, body, respond) => invoke(guard, { method: 'PUT', originalUrl: '/api/config/settings', body }, respond);

  it('strips forbidden projects, the active id pointing at one and a forbidden lastDirectory', async () => {
    const body = {
      themeId: 'dark',
      projects: [
        { id: 'ok', path: '/home/dev/projects/app' },
        { id: 'home', path: HOME },
        { id: 'omo', path: '/home/dev/.omo' },
        { id: 'broken' },
      ],
      activeProjectId: 'omo',
      lastDirectory: '/home/dev/.config/opencode',
    };
    const outcome = await put(createGuard(), body);
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.req.body).toEqual({ themeId: 'dark', projects: [{ id: 'ok', path: '/home/dev/projects/app' }] });
  });

  it('keeps an allowed active project and lastDirectory, and an OpenCode worktree as lastDirectory', async () => {
    const guard = createGuard();
    const body = { projects: [{ id: 'ok', path: '/home/dev/projects/app' }], activeProjectId: 'ok', lastDirectory: '/home/dev/projects/app' };
    expect((await put(guard, { ...body })).req.body).toEqual(body);
    const worktree = { lastDirectory: '/home/dev/.local/share/opencode/worktree/abc/feature' };
    expect((await put(guard, { ...worktree })).req.body).toEqual(worktree);
  });

  it('honours XDG_DATA_HOME for the worktree folder', async () => {
    const guard = createGuard({ dataHomeDir: '/home/dev/.data' });
    const kept = { lastDirectory: '/home/dev/.data/opencode/worktree/abc/feature' };
    expect((await put(guard, { ...kept })).req.body).toEqual(kept);
    expect((await put(guard, { lastDirectory: '/home/dev/.local/share/opencode/worktree/abc/feature' })).req.body).toEqual({});
  });

  it('leaves settings writes without project keys untouched and runs no git', async () => {
    const git = createGit();
    const outcome = await put(createGuard({ runGit: git.runGit }), { themeId: 'dark' }, (res) => res.json({ ok: true }));
    expect(outcome.req.body).toEqual({ themeId: 'dark' });
    expect(git.calls).toEqual([]);
  });

  it('initialises git in accepted projects before answering', async () => {
    const git = createGit({ repos: ['/home/dev/projects/app'] });
    const body = { projects: [{ id: 'a', path: '/home/dev/projects/app' }, { id: 'b', path: '/home/dev/projects/new' }] };
    await put(createGuard({ runGit: git.runGit }), body, (res) => res.json({ ok: true }));
    expect(git.calls).toContainEqual(['-C', '/home/dev/projects/new', 'init']);
    expect(git.calls).not.toContainEqual(['-C', '/home/dev/projects/app', 'init']);
  });

  it('passes other routes and methods through', async () => {
    const guard = createGuard();
    for (const request of [
      { method: 'GET', originalUrl: '/api/config/settings' },
      { method: 'POST', originalUrl: '/api/opencode/directory/extra', body: { path: HOME } },
      { method: 'PUT', originalUrl: '/api/projects/p/config', body: { projectPath: HOME } },
    ]) {
      const outcome = await invoke(guard, request);
      expect(outcome.nextCalled).toBe(true);
      expect(outcome.status).toBeNull();
    }
  });
});
