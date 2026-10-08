import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const LOCKED_CODE = 'multichamber_locked';
const FORBIDDEN_MESSAGE = 'This folder cannot be a project.';
const GIT_TIMEOUT_MS = 10_000;

// POST /api/opencode/directory adds (or creates) a project and makes it active (opencode/routes.js).
const DIRECTORY_SEGMENTS = ['api', 'opencode', 'directory'];
// PUT /api/config/settings persists `projects`, `activeProjectId` and `lastDirectory` (opencode/routes.js).
const SETTINGS_SEGMENTS = ['api', 'config', 'settings'];

const pathTextSchema = z.string().trim().catch('');
const projectEntrySchema = z.object({ id: z.string().optional(), path: z.string() }).passthrough();
// The route answers `{ path: resolvedPath }` (symlinks resolved).
const directoryAnswerSchema = z.object({ path: z.string().min(1) });

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

const routeSegments = (req) => {
  const pathname = new URL(String(req.originalUrl ?? req.url ?? ''), 'http://localhost').pathname;
  return pathname.toLowerCase().split('/').filter(Boolean);
};

const sameSegments = (left, right) => left.length === right.length && left.every((segment, index) => segment === right[index]);

const execGit = (args) => new Promise((resolve) => {
  execFile('git', args, { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/**
 * Whether `resolved` may be a project under `root`: not the root itself, inside the
 * root, and no segment below the root starting with `.` (harness state lives in
 * hidden folders of the home directory).
 * @param {string} resolved absolute path
 * @param {string} root absolute path
 */
export const isAllowedProjectPath = (resolved, root) => {
  const relative = path.relative(root, resolved);
  if (relative.length === 0) return false;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).every((segment) => !segment.startsWith('.'));
};

/**
 * Runs `git init` in `directory` unless it is already inside a git work tree.
 * Never throws: a failure is logged and the project add goes on.
 * @param {string} directory
 * @param {{ runGit?: (args: string[]) => Promise<{ ok: boolean, stdout: string, stderr: string }>, logger?: Pick<Console, 'warn'> }} [options]
 * @returns {Promise<'existing' | 'initialized' | 'failed'>}
 */
export const ensureGitRepository = async (directory, { runGit = execGit, logger = console } = {}) => {
  const probe = await runGit(['-C', directory, 'rev-parse', '--is-inside-work-tree']);
  if (probe.ok && probe.stdout.trim() === 'true') return 'existing';
  const init = await runGit(['-C', directory, 'init']);
  if (init.ok) return 'initialized';
  logger.warn(`[multichamber] git init failed in ${directory}: ${init.stderr.trim()}`);
  return 'failed';
};

/**
 * Lockdown guard for the routes that add projects or move the active directory:
 * refuses or strips the fs root itself, folders outside it and hidden folders, and
 * runs `git init` in every accepted project before the route answers. Returns null
 * when lockdown is off.
 * @param {{
 *   enabled: boolean,
 *   root?: string,
 *   homedir?: string,
 *   dataHomeDir?: string,
 *   realpath?: (value: string) => Promise<string>,
 *   runGit?: (args: string[]) => Promise<{ ok: boolean, stdout: string, stderr: string }>,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const createLockdownProjectGuard = ({
  enabled,
  root,
  homedir = os.homedir(),
  dataHomeDir = process.env.XDG_DATA_HOME,
  realpath = fsPromises.realpath,
  runGit = execGit,
  logger = console,
}) => {
  if (!enabled) return null;
  const rootText = pathTextSchema.parse(root);
  const allowedRoot = path.resolve(rootText.length > 0 ? rootText : homedir);
  const dataHome = pathTextSchema.parse(dataHomeDir);
  const worktreeRoot = path.join(dataHome.length > 0 ? path.resolve(dataHome) : path.join(homedir, '.local', 'share'), 'opencode', 'worktree');
  // Each directory is checked once per process; the in-flight promise dedupes concurrent adds.
  const ensured = new Map();

  const resolveText = (value) => {
    const trimmed = pathTextSchema.parse(value);
    if (trimmed.length === 0) return null;
    const expanded = trimmed === '~' || trimmed.startsWith('~/') ? homedir + trimmed.slice(1) : trimmed;
    return path.resolve(expanded);
  };

  // A symlink inside the root may point at a hidden folder; a missing folder keeps its literal path.
  const isAllowed = async (value) => {
    const resolved = resolveText(value);
    if (resolved === null) return false;
    if (!isAllowedProjectPath(resolved, allowedRoot)) return false;
    const real = await realpath(resolved).then((target) => target, () => resolved);
    return isAllowedProjectPath(real, allowedRoot);
  };

  const ensureGit = (value) => {
    const resolved = resolveText(value);
    if (resolved === null) return Promise.resolve();
    let pending = ensured.get(resolved);
    if (!pending) {
      pending = ensureGitRepository(resolved, { runGit, logger }).then((outcome) => {
        if (outcome === 'failed') ensured.delete(resolved);
      });
      ensured.set(resolved, pending);
    }
    return pending;
  };

  // Delays a successful JSON answer until `task` has run, so the UI never sees a fresh project before `git init`.
  const beforeSuccessJson = (res, task) => {
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      if ((res.statusCode ?? 200) >= 400) return sendJson(body);
      task(body).then(() => sendJson(body));
      return res;
    };
  };

  const refuse = (res) => res.status(403).json({ error: FORBIDDEN_MESSAGE, code: LOCKED_CODE });

  // `lastDirectory` also follows the UI into OpenCode worktrees, which live in a hidden data folder.
  const isAllowedLastDirectory = async (value) => {
    const resolved = resolveText(value);
    if (resolved === null) return true;
    const relative = path.relative(worktreeRoot, resolved);
    if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) return true;
    return isAllowed(value);
  };

  const handleDirectory = async (req, res, next) => {
    const requested = isPlainObject(req.body) ? req.body.path : undefined;
    // A blank path gets the route's own 400.
    if (resolveText(requested) === null) {
      next();
      return;
    }
    if (!(await isAllowed(requested))) {
      refuse(res);
      return;
    }
    beforeSuccessJson(res, (body) => {
      const answer = directoryAnswerSchema.safeParse(body);
      return ensureGit(answer.success ? answer.data.path : requested);
    });
    next();
  };

  const handleSettings = async (req, res, next) => {
    const body = req.body;
    if (!isPlainObject(body)) {
      next();
      return;
    }
    const accepted = [];
    if (Array.isArray(body.projects)) {
      const kept = [];
      const droppedIds = new Set();
      for (const entry of body.projects) {
        const parsed = projectEntrySchema.safeParse(entry);
        if (parsed.success && (await isAllowed(parsed.data.path))) {
          kept.push(entry);
          accepted.push(parsed.data.path);
        } else if (parsed.success && parsed.data.id) {
          droppedIds.add(parsed.data.id);
        }
      }
      body.projects = kept;
      if (droppedIds.has(body.activeProjectId)) delete body.activeProjectId;
    }
    if ('lastDirectory' in body && !(await isAllowedLastDirectory(body.lastDirectory))) delete body.lastDirectory;
    if (accepted.length > 0) beforeSuccessJson(res, () => Promise.all(accepted.map(ensureGit)));
    next();
  };

  return (req, res, next) => {
    const method = String(req.method ?? '').toUpperCase();
    const segments = routeSegments(req);
    let handler = null;
    if (method === 'POST' && sameSegments(segments, DIRECTORY_SEGMENTS)) handler = handleDirectory;
    else if (method === 'PUT' && sameSegments(segments, SETTINGS_SEGMENTS)) handler = handleSettings;
    if (handler === null) {
      next();
      return;
    }
    handler(req, res, next).catch(next);
  };
};
