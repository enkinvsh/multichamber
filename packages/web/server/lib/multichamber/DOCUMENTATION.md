# MultiChamber filesystem root guard

`fs-root-guard.js` keeps the UI inside one folder. Set `MULTICHAMBER_FS_ROOT` (for example `/home/dev`) and every `/api/` request that names a path outside it gets `403` with code `outside_fs_root`. Unset or blank: the guard is not mounted and nothing changes. It is mounted in `server/index.js` right after `spaceArchive.guard`.

What is checked (route prefixes match case-insensitively):

- Every `/api/` request: query `directory` and `location[directory]`, the `x-opencode-directory` header (URI-decoded the same way as `spaces/dispatcher.js`), and query `path` only when it is absolute (`/…` or `~…`). Relative `path` values on proxied OpenCode routes are relative to the project and pass.
- `/api/fs/*`: query `path` (relative too) and JSON body keys `path`, `oldPath`, `newPath`, `cwd`, `destinationPath`, `targetPath`, `directory`.
- `/api/projects*`: JSON body key `projectPath` (`PUT /api/projects/:projectId/config`, `projects/project-setup.js`).
- `POST /api/openchamber/directory`: JSON body key `path` (opens a folder as the project, `projects/routes.js`).

A value is expanded (`~` → home folder), resolved with `path.resolve`, and must equal the root or sit below it, so `/home/dev2` and `/home/dev/../etc` are refused.

This is a UX boundary, not a security boundary: the container (read-only rootfs, non-root user) is the security boundary; a symlink or the terminal can still reach outside.

# MultiChamber lockdown

`lockdown-guard.js` turns OpenChamber into a managed product: users keep chatting, editing files and using git, but cannot change providers, keys, quotas, MCP, plugins, tunnels, updates or integrations. Set `MULTICHAMBER_LOCKDOWN=1` (the MultiChamber image does). Any other value: nothing is mounted and nothing changes.

Server side (`server/index.js`):

- `createLockdownGuard` is mounted right after `compression`, before `setupBaseRoutes`, because `/api/system/*`, `/auth/passkey/register/*`, `/api/client-auth/*` and `/api/openchamber/update-install` are registered there (some before the API auth gate). A blocked request gets `403 { error: 'This setting is managed by MultiChamber.', code: 'multichamber_locked' }`, even before login.
- Writes (anything but GET/HEAD/OPTIONS) are blocked under `/api/provider`, `/api/config/{mcp,plugins,websearch,skills/install}`, `/api/behavior/agents-md`, `/api/system`, `/api/routing`, `/api/client-auth`, `/api/{github,source-control/github}/auth`, `/api/voice/keys`, `/api/openchamber/spaces`, and the proxied OpenCode routes `/api/credential`, `/api/experimental/{config,mcp}`, `/api/plugin`, `/api/integration`, `/api/debug`.
- Every method is blocked under `/api/quota`, `/api/openchamber/{tunnel,relay,update-install}`, `/api/opencode/{install-v2,upgrade}`, `/api/guests`, `/auth/passkey/register`, `/api/linear`, `/api/source-control/gitlab/auth`, `/api/dictation/models/*/download`, `/api/experimental/integration/wellknown`, `/api/pair`.
- Paths are matched like `enterprise-mode.js` `routeSegments`: lowercased, segments decoded (a decoded `/` splits again), empty segments ignored. An undecodable path or a `.`/`..` segment under `/api` or `/auth` is refused.
- `createLockdownSettingsFilter` is mounted after the fs root guard (bodies are parsed there). It does not block `PUT /api/config/settings` (theme and other per-user preferences save through it); it deletes the keys in `LOCKDOWN_DENIED_SETTINGS` from the body: every `scope: "instance"` key of `opencode/settings-registry.json` except a short allow-list of workspace/UI keys. New upstream instance keys are denied by default.
- `GET /api/openchamber/enterprise-policy` reports `multichamberLockdown: true`.

UI side (`packages/ui/src/lib/multichamber/lockdown.ts`): `useMultichamberLockdown()` reads that flag; locked Settings pages (`LOCKED_SETTINGS_PAGES`) leave the nav, search and command palette, deep links fall back to Appearance; "Add new provider", quota/usage widgets and integration-settings buttons are hidden, and the quota store stops fetching.

This is a product/UX boundary, not a security boundary: the container (read-only rootfs, non-root user, home as the only writable volume) is the security boundary; the terminal can still edit config files in home.
