import { createRequire } from 'node:module';

const LOCKED_MESSAGE = 'This setting is managed by MultiChamber.';
const LOCKED_CODE = 'multichamber_locked';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Blocked route prefixes for OpenChamber 1.x and OpenCode 1.x. `*` matches any
 * one segment. A rule matches its own path and everything below it unless
 * `exact` is set. `writes` blocks every method except GET/HEAD/OPTIONS; `all`
 * blocks every method. Paths are compared lowercased because Express routes
 * case-insensitively.
 *
 * GET status reads the UI polls (guests, linear/github auth status, tunnel
 * status, update-check, quota) stay open: the UI hides those features instead.
 */
const RULES = [
  // OpenChamber: providers (PUT /api/provider, DELETE /api/provider/:id/auth,
  // POST /api/provider/:id/oauth/callback) and OpenCode POST /provider/:id/oauth/*.
  { path: '/api/provider', block: 'writes' },
  { path: '/api/provider/*/oauth', block: 'all' },
  // OpenCode PUT|DELETE /auth/:providerID. POST /api/auth/reset (OpenChamber sign-out) is allowed below.
  { path: '/api/auth', block: 'writes' },
  // OpenCode config writes: PATCH /config, PATCH /global/config.
  { path: '/api/config', block: 'writes', exact: true },
  { path: '/api/global/config', block: 'writes' },
  { path: '/api/global/upgrade', block: 'all' },
  // OpenCode MCP: POST /mcp, /mcp/:name/auth*, /mcp/:name/connect|disconnect;
  // OpenChamber /api/mcp/auth/pending and /api/mcp/:name/auth/authenticate.
  { path: '/api/mcp', block: 'writes' },
  // OpenChamber config files.
  { path: '/api/config/mcp', block: 'writes' },
  { path: '/api/config/plugins', block: 'writes' },
  { path: '/api/config/skills/install', block: 'all' },
  { path: '/api/config/skills/scan', block: 'all' },
  { path: '/api/behavior/agents-md', block: 'writes' },
  // Quota credentials stay closed; GET usage reads stay open.
  { path: '/api/quota/credentials', block: 'all' },
  { path: '/api/quota', block: 'writes' },
  { path: '/api/openchamber/tunnel', block: 'writes' },
  { path: '/api/openchamber/relay', block: 'writes' },
  { path: '/api/openchamber/update-install', block: 'all' },
  { path: '/api/opencode/upgrade', block: 'all' },
  // POST /api/system/probe-url stays open: the dev-server preview uses it.
  { path: '/api/system/shutdown', block: 'all' },
  { path: '/api/system/dev-shutdown', block: 'all' },
  // Guest panels: install/update/oauth. GET /api/guests (startup list) stays open.
  { path: '/api/guests', block: 'writes' },
  { path: '/api/guests/*/oauth', block: 'all' },
  { path: '/api/routing', block: 'writes' },
  { path: '/api/client-auth', block: 'writes' },
  { path: '/api/passkeys', block: 'writes' },
  { path: '/auth/passkey/register', block: 'all' },
  // Integrations sign-in. GET auth/status stays readable.
  { path: '/api/linear', block: 'writes' },
  { path: '/linear/oauth', block: 'all' },
  { path: '/mcp/oauth', block: 'all' },
  { path: '/api/github/auth', block: 'writes' },
  // Voice: OpenAI realtime token, TTS with a caller-supplied key and base URL, model downloads.
  { path: '/api/voice', block: 'writes' },
  { path: '/api/tts', block: 'writes' },
  { path: '/api/dictation/models', block: 'writes' },
  { path: '/api/dictation/models/*/download', block: 'all' },
  // OpenCode cloud console org switch.
  { path: '/api/experimental/console', block: 'writes' },
  // OpenCode v2 API (`/api/*` on OpenCode, reached as `/api/api/*` through the proxy).
  { path: '/api/api/credential', block: 'writes' },
  { path: '/api/api/integration', block: 'writes' },
  { path: '/api/credential', block: 'writes' },
  { path: '/api/integration', block: 'writes' },
  // OpenCode session sharing (POST|DELETE /session/:id/share): share is off in the slot config.
  { path: '/api/session/*/share', block: 'writes' },
  { path: '/api/api/session/*/share', block: 'writes' },
].map((rule) => ({ ...rule, segments: rule.path.split('/').filter(Boolean) }));

/** Writes that a matching rule would block but that stay open. */
const EXCEPTIONS = [
  // OpenChamber global sign-out (lib/opencode/core-routes.js).
  { method: 'POST', segments: ['api', 'auth', 'reset'] },
];

const GUARDED_ROOTS = new Set(['api', 'auth', 'linear', 'mcp']);
const GUARDED_RAW_PATH = /^[\\/]*(?:api|auth|linear|mcp)(?:[\\/?#;]|$)/i;

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
  'agentControlToolEnabled',
  'agentWebToolEnabled',
  'agentMemoryToolEnabled',
  'openCodeUpdateToastDismissedVersion',
  'autoDeleteEnabled',
  'autoDeleteAfterDays',
  'sessionRetentionOnlyArchived',
  'sessionRetentionAction',
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
 * Lowercased path segments, or null when the path cannot be read safely
 * (bad percent-encoding or a `.`/`..` segment). A decoded segment may itself
 * hold `/` (from `%2F`); it is split again so a downstream server that decodes
 * it sees the same route we checked.
 */
const lockdownSegments = (rawPath) => {
  const pathOnly = String(rawPath).split(/[?#;]/, 1)[0];
  const segments = [];
  for (const raw of pathOnly.split(/[\\/]/)) {
    if (!raw) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    for (const part of decoded.split(/[\\/]/)) {
      if (!part) continue;
      if (part === '.' || part === '..') return null;
      segments.push(part.toLowerCase());
    }
  }
  return segments;
};

const matchesRule = (segments, rule) =>
  (rule.exact ? segments.length === rule.segments.length : segments.length >= rule.segments.length)
  && rule.segments.every((expected, index) => expected === '*' || expected === segments[index]);

const isException = (method, segments) => EXCEPTIONS.some((exception) =>
  exception.method === method
  && exception.segments.length === segments.length
  && exception.segments.every((segment, index) => segment === segments[index]));

const isBlocked = (method, segments) => {
  if (isException(method, segments)) return false;
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
