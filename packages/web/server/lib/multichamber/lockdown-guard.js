import { createRequire } from 'node:module';
import { routeSegments } from '../enterprise-mode.js';

const LOCKED_MESSAGE = 'This setting is managed by MultiChamber.';
const LOCKED_CODE = 'multichamber_locked';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Blocked route prefixes. `*` matches any one segment. A rule matches its own
 * path and everything below it. `writes` blocks every method except
 * GET/HEAD/OPTIONS; `all` blocks every method. Paths are compared lowercased
 * because Express routes case-insensitively.
 */
const RULES = [
  // OpenChamber server routes.
  { path: '/api/provider', block: 'writes' },
  { path: '/api/config/mcp', block: 'writes' },
  { path: '/api/config/plugins', block: 'writes' },
  { path: '/api/config/websearch', block: 'writes' },
  { path: '/api/config/skills/install', block: 'writes' },
  { path: '/api/behavior/agents-md', block: 'writes' },
  { path: '/api/quota', block: 'all' },
  { path: '/api/openchamber/tunnel', block: 'all' },
  { path: '/api/openchamber/relay', block: 'all' },
  { path: '/api/openchamber/update-install', block: 'all' },
  { path: '/api/opencode/install-v2', block: 'all' },
  { path: '/api/opencode/upgrade', block: 'all' },
  { path: '/api/system', block: 'writes' },
  { path: '/api/guests', block: 'all' },
  { path: '/api/routing', block: 'writes' },
  { path: '/api/client-auth', block: 'writes' },
  { path: '/auth/passkey/register', block: 'all' },
  { path: '/api/linear', block: 'all' },
  { path: '/api/source-control/gitlab/auth', block: 'all' },
  // GitHub sign-in (lib/github/routes.js githubAuthRoutePaths). GET status/accounts stay readable.
  { path: '/api/github/auth', block: 'writes' },
  { path: '/api/source-control/github/auth', block: 'writes' },
  { path: '/api/voice/keys', block: 'writes' },
  { path: '/api/dictation/models/*/download', block: 'all' },
  // SPACES_ROUTE in lib/spaces/routes.js.
  { path: '/api/openchamber/spaces', block: 'writes' },
  // OpenCode routes proxied through /api/*.
  { path: '/api/credential', block: 'writes' },
  { path: '/api/experimental/config', block: 'writes' },
  { path: '/api/experimental/mcp', block: 'writes' },
  { path: '/api/plugin', block: 'writes' },
  { path: '/api/integration', block: 'writes' },
  { path: '/api/experimental/integration/wellknown', block: 'all' },
  { path: '/api/pair', block: 'all' },
  { path: '/api/debug', block: 'writes' },
].map((rule) => ({ ...rule, segments: rule.path.split('/').filter(Boolean) }));

const GUARDED_ROOTS = new Set(['api', 'auth']);
// Same shape enterprise-mode.js uses for a path whose segments cannot be read.
const GUARDED_RAW_PATH = /^[\\/]*(?:api|auth)(?:[\\/?#;]|$)/i;

const SETTINGS_SEGMENTS = ['api', 'config', 'settings'];

/**
 * Instance-scope settings a MultiChamber user may still change. Every other
 * instance-scope key in settings-registry.json is stripped, so a key added by
 * upstream is denied until someone reviews it.
 */
const ALLOWED_INSTANCE_SETTINGS = new Set([
  // Workspace state; the paths are already held inside home by fs-root-guard.
  'lastDirectory',
  'projects',
  'activeProjectId',
  'pinnedDirectories',
  // Per-user preferences with no reach outside the container.
  'defaultGitIdentityId',
  'permissionAutoAccept',
  'permissionDefaultMode',
  'messageSearchEnabled',
  'messageSearchReasoningEnabled',
  'openCodeUpdateToastDismissedVersion',
  'autoDeleteEnabled',
  'autoDeleteAfterDays',
  'sessionRetentionOnlyArchived',
  'sessionRetentionAction',
  'mergedWorktreeCleanupEnabled',
  'openInAppId',
  'pwaAppName',
  'pwaOrientation',
  'desktopSplashColors',
  'desktopWindowState',
]);

const settingsRegistry = createRequire(import.meta.url)('../opencode/settings-registry.json');

/** Settings keys stripped from PUT /api/config/settings in lockdown. */
export const LOCKDOWN_DENIED_SETTINGS = Object.freeze(
  Object.entries(settingsRegistry.fields)
    .filter(([key, field]) => field.scope === 'instance' && !ALLOWED_INSTANCE_SETTINGS.has(key))
    .map(([key]) => key),
);

const DENIED_SETTINGS = new Set(LOCKDOWN_DENIED_SETTINGS);

/** True when the server runs in MultiChamber lockdown (env MULTICHAMBER_LOCKDOWN=1). */
export const isLockdownEnabled = (env = process.env) => env.MULTICHAMBER_LOCKDOWN === '1';

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

const requestPath = (req) => String(req.originalUrl ?? req.url ?? '');

/**
 * Lowercased path segments, or null when the path cannot be read safely.
 * A decoded segment may itself hold `/` (from `%2F`); it is split again so a
 * downstream server that decodes it sees the same route we checked.
 */
const lockdownSegments = (rawPath) => {
  const decoded = routeSegments(rawPath);
  if (decoded === null) return null;
  const segments = [];
  for (const segment of decoded) {
    for (const part of segment.split(/[\\/]/)) {
      if (!part) continue;
      if (part === '.' || part === '..') return null;
      segments.push(part.toLowerCase());
    }
  }
  return segments;
};

const matchesRule = (segments, rule) =>
  segments.length >= rule.segments.length
  && rule.segments.every((expected, index) => expected === '*' || expected === segments[index]);

const isBlocked = (method, segments) => {
  const isWrite = !READ_METHODS.has(method);
  return RULES.some((rule) => (rule.block === 'all' || isWrite) && matchesRule(segments, rule));
};

const refuse = (res) => {
  res.status(403).json({ error: LOCKED_MESSAGE, code: LOCKED_CODE });
};

/**
 * Refuses requests that change providers, keys, quotas, MCP, plugins, tunnels,
 * updates or integrations. Returns null when lockdown is off. Install it before
 * any route it names: several are registered ahead of the API auth gate.
 * A product boundary, not a security boundary: see DOCUMENTATION.md.
 * @param {{ enabled?: boolean }} options
 */
export const createLockdownGuard = ({ enabled = false } = {}) => {
  if (enabled !== true) return null;
  return (req, res, next) => {
    const rawPath = requestPath(req);
    const segments = lockdownSegments(rawPath);
    if (segments === null) {
      if (GUARDED_RAW_PATH.test(rawPath)) {
        refuse(res);
        return;
      }
      next();
      return;
    }
    if (segments.length > 0 && GUARDED_ROOTS.has(segments[0]) && isBlocked(String(req.method).toUpperCase(), segments)) {
      refuse(res);
      return;
    }
    next();
  };
};

/**
 * Drops denied keys from a settings write so the rest of the save (theme and
 * other per-user preferences) still goes through. Needs a parsed body, so it is
 * installed after the body parsers. Returns null when lockdown is off.
 * @param {{ enabled?: boolean }} options
 */
export const createLockdownSettingsFilter = ({ enabled = false } = {}) => {
  if (enabled !== true) return null;
  return (req, _res, next) => {
    const method = String(req.method).toUpperCase();
    if (READ_METHODS.has(method) || !isPlainObject(req.body)) {
      next();
      return;
    }
    const segments = lockdownSegments(requestPath(req));
    const isSettingsRoute = segments !== null
      && segments.length === SETTINGS_SEGMENTS.length
      && SETTINGS_SEGMENTS.every((segment, index) => segment === segments[index]);
    if (isSettingsRoute) {
      for (const key of Object.keys(req.body)) {
        if (DENIED_SETTINGS.has(key)) delete req.body[key];
      }
    }
    next();
  };
};
