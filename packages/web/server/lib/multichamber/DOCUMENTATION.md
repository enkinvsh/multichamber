# MultiChamber (v1 line: OpenChamber 1.24.2 on OpenCode 1.x)

Everything MultiChamber adds to the server lives here. `install.js` is the only entry point; `server/index.js` calls it twice:

- `installMultichamber(app, 'early')` right after `app.use(compression(...))`, before `bootstrapRuntime.setupBaseRoutes`. Mounts the lockdown guard and `GET /api/multichamber/policy`. It has to precede `setupBaseRoutes` because `/api/system/*`, `/auth/passkey/*`, `/api/client-auth/*`, `/api/passkeys` and `/api/openchamber/update-install` are registered there, some before the UI auth gate.
- `installMultichamber(app, 'parsed')` right after `uiAuthController = bootstrapResult.uiAuthController`. The JSON body parsers (`core-routes.js` `registerCommonRequestMiddleware`) are installed inside `setupBaseRoutes`, and the fs, settings and projects routes (`featureRoutesRuntime`) and the OpenCode proxy (`startupPipelineRuntime`) come after this point. Mounts the settings key filter and the filesystem root guard.

1.x has no enterprise mode, so there is no `enterprise-mode.js` and no `policy.json`.

## Policy endpoint

`GET /api/multichamber/policy` returns `{ lockdown: boolean, fsRoot: string | null }` (`lockdown` is `MULTICHAMBER_LOCKDOWN === '1'`, `fsRoot` is the trimmed `MULTICHAMBER_FS_ROOT`). The UI reads it once (`packages/ui/src/lib/multichamber/lockdown.ts`); a `404` means a plain OpenChamber server and leaves everything unlocked.

## Filesystem root guard

`fs-root-guard.js` keeps the UI inside one folder. Set `MULTICHAMBER_FS_ROOT` (for example `/home/dev`) and every `/api/` request that names a path outside it gets `403 { error: 'Path is outside the allowed folder.', code: 'outside_fs_root' }`. Unset or blank: the guard is not mounted.

What is checked (route prefixes match case-insensitively):

- Every `/api/` request: query `directory` and `location[directory]`, the `x-opencode-directory` header (URI-decoded when `x-opencode-directory-encoding: uri` is sent, as `opencode/proxy.js` does), and query `path` only when it is absolute (`/…` or `~…`). Relative `path` values on proxied OpenCode routes are relative to the project and pass.
- `/api/fs/*` (`fs/routes.js`): query `path` (relative too) and JSON body keys `path`, `oldPath`, `newPath`, `cwd`, `destinationPath`, `targetPath`, `directory`.
- `/api/projects*`: JSON body key `projectPath` (`PUT /api/projects/:projectId/config`, `projects/project-setup.js`).
- `POST /api/opencode/directory`: JSON body key `path` (switches the OpenCode working directory, `opencode/routes.js`).

A value is expanded (`~` → home folder), resolved with `path.resolve`, and must equal the root or sit below it, so `/home/dev2` and `/home/dev/../etc` are refused.

This is a UX boundary, not a security boundary: the container (read-only rootfs, non-root user) is the security boundary; a symlink or the terminal can still reach outside.

## Lockdown

`lockdown-guard.js` turns OpenChamber into a managed product: users keep chatting, editing files and using git, but cannot change providers, keys, quotas, MCP, plugins, tunnels, updates or integrations. Set `MULTICHAMBER_LOCKDOWN=1` (the image does). Any other value: nothing is mounted.

A blocked request gets `403 { error: 'This setting is managed by MultiChamber.', code: 'multichamber_locked' }`, even before login. GET status reads the UI makes at startup or while polling (`/api/guests`, `/api/linear/auth/status`, `/api/github/auth/status`, `/api/quota/providers`, tunnel/relay status, update-check, upgrade-status) stay open; the UI stops rendering the features instead.

`RULES` (prefix match on segments, `*` = one segment):

- Writes (anything but GET/HEAD/OPTIONS): `/api/provider`, `/api/auth` (except `POST /api/auth/reset`, the OpenChamber sign-out), `/api/config` (exact: OpenCode `PATCH /config`), `/api/global/config`, `/api/mcp`, `/api/config/mcp`, `/api/config/plugins`, `/api/behavior/agents-md`, `/api/quota`, `/api/openchamber/tunnel`, `/api/openchamber/relay`, `/api/guests`, `/api/routing`, `/api/client-auth`, `/api/passkeys`, `/api/linear`, `/api/github/auth`, `/api/voice`, `/api/tts`, `/api/dictation/models`, `/api/experimental/console`, and OpenCode's v2 `/api/credential`, `/api/integration` (reachable as `/api/api/...` through the proxy, both forms are listed).
- Every method: `/api/provider/*/oauth`, `/api/global/upgrade`, `/api/config/skills/install`, `/api/config/skills/scan`, `/api/quota/credentials`, `/api/openchamber/update-install`, `/api/opencode/upgrade`, `/api/system/shutdown`, `/api/system/dev-shutdown`, `/api/guests/*/oauth`, `/auth/passkey/register`, `/linear/oauth`, `/mcp/oauth`, `/api/dictation/models/*/download`.
- Paths are lowercased, segments decoded (a decoded `/` or `\` splits again), empty segments ignored. An undecodable path or a `.`/`..` segment under `/api`, `/auth`, `/linear` or `/mcp` is refused.

`createLockdownSettingsFilter` does not block `PUT /api/config/settings` (theme and chat preferences save through it); it deletes the keys in `LOCKDOWN_DENIED_SETTINGS` from the body: every `scope: "instance"` key of `opencode/settings-registry.json` except `ALLOWED_INSTANCE_SETTINGS` (workspace/UI keys such as `projects`, `lastDirectory`, `pinnedDirectories`, session retention, `openInAppId`). New upstream instance keys are denied by default. `opencodeBinary` is denied so the image's `OPENCODE_BINARY` stays in force.

Not locked on the server: the dictation WebSocket (`/api/dictation/ws`) is an `upgrade` handler, not an Express route, and the local STT model downloads on its first use; the UI hides dictation in lockdown instead. `POST /api/system/probe-url` stays open because the dev-server preview uses it.

UI side (`packages/ui/src/lib/multichamber/lockdown.ts`): `useMultichamberLockdown()`; `MULTICHAMBER_LOCKED_SETTINGS_PAGES` in `lib/settings/metadata.ts` leave the nav, search and command palette, deep links fall back to the first visible page; provider/MCP/usage/update/integration/dictation/open-in-app entry points are hidden.

This is a product/UX boundary, not a security boundary: the container (read-only rootfs, non-root user, home as the only writable volume) is the security boundary; the terminal can still edit config files in home.
