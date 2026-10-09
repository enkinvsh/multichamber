# MultiChamber (v1 line: OpenChamber 1.24.2 on OpenCode 1.x)

Everything MultiChamber adds to the server lives here. `install.js` is the entry point for the guards and API routes; `server/index.js` calls it twice:

- `installMultichamber(app, 'early')` right after `app.use(compression(...))`, before `bootstrapRuntime.setupBaseRoutes`. Mounts the lockdown guard and `GET /api/multichamber/policy`. It has to precede `setupBaseRoutes` because `/api/system/*`, `/auth/passkey/*`, `/api/client-auth/*`, `/api/passkeys` and `/api/openchamber/update-install` are registered there, some before the UI auth gate.
- `installMultichamber(app, 'parsed')` right after `uiAuthController = bootstrapResult.uiAuthController`. The JSON body parsers (`core-routes.js` `registerCommonRequestMiddleware`) are installed inside `setupBaseRoutes`, and the fs, settings and projects routes (`featureRoutesRuntime`) and the OpenCode proxy (`startupPipelineRuntime`) come after this point. Mounts the settings key filter, the filesystem root guard, the project guard and `GET /api/multichamber/budget`.

The white label (`brand.js`) plugs into the theme, settings and static-file runtimes, so `server/index.js` creates it directly; see [White label](#white-label).

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

Session sharing (`POST|DELETE /api/session/:id/share`, also `/api/api/...`) is refused as a write; share is off in the slot config.

### Projects (`project-guard.js`)

Mounted in the `parsed` stage after the fs root guard, lockdown only. Root = `MULTICHAMBER_FS_ROOT`, or the home folder when unset. A project path must sit strictly below the root, and no segment below the root may start with `.` (`~/.omo`, `~/.config`, `~/.local/share` hold harness state). The check runs on the `~`-expanded path and again on its `realpath`, so a symlink into a hidden folder is refused too.

Routes that add projects or move the active directory (all other `persistSettings` callers only edit existing project entries, such as `project-icon-routes.js`):

- `POST /api/opencode/directory` (adds/creates a project, sets `activeProjectId` and `lastDirectory`): a forbidden `path` gets `403 { error: 'This folder cannot be a project.', code: 'multichamber_locked' }`; a blank one reaches the route's own `400`.
- `PUT /api/config/settings`: forbidden `projects` entries are stripped, `activeProjectId` is dropped when it named one, and a forbidden `lastDirectory` is dropped. `lastDirectory` may also point into OpenCode worktrees (`$XDG_DATA_HOME|~/.local/share` + `/opencode/worktree`).

On a successful answer of either route the guard runs `git init` (no commit) in each accepted project that `git rev-parse --is-inside-work-tree` does not report as a work tree, before the JSON goes out, so the Git, Changes and Walkthrough panels work at once. Each directory is checked once per process; a failed `git init` logs a warning and the project add still succeeds.

### Dev-server discovery (`dev-server-ownership.js`)

`createMultichamberDevServerFilter` is passed to `createDevServerScanner({ filterServers })` in `server/index.js`. In lockdown on Linux it keeps a listening port only when its socket inode (from `/proc/net/tcp(6)`) is held, per `/proc/<pid>/fd`, by a strict descendant of the OpenChamber process (parents from `/proc/<pid>/stat`). Ports held by the managed `opencode serve` (pid from the lifecycle module, or any `opencode … serve` command line between it and this server) are dropped, as are ports with no resolvable owner (the harness memory server, other users). Dev servers an agent or a terminal starts are descendants and stay. The same scanner feeds the dev tunnel allowlist, so dropped ports are not tunnelled either.

UI side (`packages/ui/src/lib/multichamber/lockdown.ts`): `useMultichamberLockdown()`; `MULTICHAMBER_LOCKED_SETTINGS_PAGES` in `lib/settings/metadata.ts` leave the nav, search and command palette, deep links fall back to the first visible page; provider/MCP/usage/update/integration/dictation/open-in-app entry points are hidden. The policy fetch starts at bootstrap (`main.tsx`, `renderMobileApp.tsx`); while it is pending the web runtime treats lockdown as on (fail-closed), and a failed fetch means unlocked (a server without the route is not MultiChamber). Also hidden in lockdown: About (sidebar footer, Electron menu), Share/Unshare/copy share link (session menus), the Linear and PR context panels (rail, panel chooser, number keys; persisted tabs are closed), the Usage and MCP rows in "Choose sections", multi-run (sidebar button, palette, message action), the hidden-folders toggle in the directory picker, and the `toggle-memory-debug` palette command (`lib/multichamber/{commands,panels,work-status}.ts`).

Browser panel (lockdown): hidden like Linear and PR (`'browser'` in `LOCKED_CONTEXT_MODES`: rail, panel chooser, number keys, `openContextSurface`/`openContextPanelTab` refuse it). Persisted browser tabs are closed once the policy has loaded with lockdown on (`useMultichamberLockdownConfirmed`, so the fail-closed guess on an unlocked server never closes tabs); until then the panel just does not mount them. Why: the panel frames pages in the user's own browser, so `http://localhost:8123` from a dev server started in the slot points at the user's machine, not the container (the dev tunnel in `lib/browser/devTunnel.ts` only exists in Electron), and most external sites refuse to be framed. URL openers (preview buttons in chat messages and markdown, the terminal's preview button) go through `lib/multichamber/browser.ts` from `openContextPreview`: a non-loopback http(s) URL opens in a new tab (`noopener,noreferrer`), a loopback URL shows the info toast `contextPanel.browser.toast.workspacePreviewUnavailable`, anything else is ignored. Project actions are hidden as well: the header's Auto-discover / "Choose project action" split button (`Header.tsx`) and the Actions section of project settings (`ProjectSettingsPanel.tsx`). Without a preview they could only end in a "No dev server command found" toast or a terminal run with nothing to open; dev servers still start from the terminal or through the agent. The agent's `browser.open` has no opener registered, so agent browser control goes unanswered (the agent sees a timeout). Planned: a per-slot preview proxy (a per-slot subdomain that forwards to the slot's dev-server ports, authenticated with the slot's session cookie); the panel comes back once that exists.

This is a product/UX boundary, not a security boundary: the container (read-only rootfs, non-root user, home as the only writable volume) is the security boundary; the terminal can still edit config files in home.

## White label

`brand.js` lets a host product rebrand the web UI through environment variables. Every variable is optional. With none of them set, `createMultichamberBrand` returns null and the server is stock: no `/brand/` route, no inline brand config, and `GET /api/multichamber/budget` answers 404. Lockdown is independent of all this, and it blocks neither `/brand/` nor the budget route.

| Variable | Effect | Unset |
|---|---|---|
| `MULTICHAMBER_BRAND_NAME` | Product name, up to 64 characters. Used in `<title>`, `application-name` and `apple-mobile-web-app-title`, the manifest `name` and `short_name` (first 30 characters), the browser tab title suffix, the header title when neither a session nor a project is open, and the settings copy that names the app: the app settings group, the Appearance page description, the settings window description for screen readers and the default install name for the PWA. Other strings that mention OpenChamber stay stock; most sit on pages that lockdown hides. | `OpenChamber` |
| `MULTICHAMBER_BRAND_ASSETS_DIR` | Folder with any of `favicon.svg`, `favicon.ico`, `apple-touch-icon-180x180.png`, `apple-touch-icon-167x167.png`, `apple-touch-icon-152x152.png`, `icon-192.png`, `icon-512.png`, `logo.svg`. Served at `/brand/<file>`; the page and the manifest link only the files that exist. `logo.svg` draws with `currentColor` and replaces the OpenChamber cube wherever the UI shows it (loading screen, startup overlay, empty chat, sign-in screen). | stock icons and cube |
| `MULTICHAMBER_THEMES_DIR` | Extra theme JSON files, same format and loader as `~/.config/openchamber/themes/`. The page carries them inline, so the theme picker lists them like built-in themes: there on the first paint, never deletable. `GET /api/config/themes` keeps listing only the user's themes, and a user theme with the same id wins. | none |
| `MULTICHAMBER_DEFAULT_THEME_DARK`, `MULTICHAMBER_DEFAULT_THEME_LIGHT` | Theme ids for users who have not picked a theme yet. A built-in id or one from either themes folder, with the matching variant; the server does not check that it exists. They also colour the loading screen, `theme-color` and the manifest. | `openchamber-dark`, `openchamber-light` |
| `MULTICHAMBER_DEFAULT_LOCALE` | Interface language for users who have not picked one yet (`ru`, `en`, `pt-BR`, ...; a stored choice or the host language wins). | English |
| `MULTICHAMBER_ACCOUNT_URL` | Account menu item "Account" (ru "Кабинет"), same tab. | item hidden |
| `MULTICHAMBER_PLANS_URL` | Menu item "Plan" ("Тариф"), same tab, and "Change plan" on the exhausted panel. | hidden |
| `MULTICHAMBER_TOPUP_URL` | Menu item "Top up" ("Докупить"), same tab, and "Top up" on the budget banners. | hidden |
| `MULTICHAMBER_SUPPORT_URL` | Menu item "Support" ("Поддержка"), new tab. | hidden |
| `MULTICHAMBER_LOGOUT_URL` | Menu item "Log out" ("Выйти"), same tab. | hidden |
| `MULTICHAMBER_BUDGET_URL` | Upstream of `GET /api/multichamber/budget`. Turns on the budget pill and banners. | route answers 404, no budget UI |

Links take an absolute `http(s)` URL or a path on this origin such as `/account`. With all five link variables unset there is no account menu. A value that fails validation is dropped and logged as `[multichamber] ignoring invalid <VARIABLE>`. The value itself never reaches the log, because links and the budget URL can carry tokens. A missing folder logs `[multichamber] <VARIABLE> does not exist, using stock files`.

### How the brand reaches the browser

The server rewrites `index.html` on every request for `/`, `/index.html` and the SPA fallback (`installRoutes` in `brand.js`, registered by `opencode/static-routes-runtime.js` ahead of `express.static`). `index-html.js` swaps the name, the favicon and apple-touch links, `theme-color` and the loading screen. The loading logo is a CSS mask filled with the splash stroke colour, and the splash colours come from the default themes. It also adds `<script id="multichamber-brand" type="application/json">` with `{ name, logoUrl, defaultThemes, themes, links, budget }`. The UI reads that script once at startup (`packages/ui/src/lib/multichamber/brand.ts`) and drops any field that fails its own validation. `themes` carries the brand folder's themes and the two default themes, so the first paint already uses them. Every theme in that folder rides along on each page load, so keep the folder to the themes the product offers. If the rewrite throws, the stock page goes out and a warning is logged.

Brand files and theme folders are read per request. Replacing the kit on disk needs no restart; changing a variable does.

`GET /brand/<file>` answers only the eight names above. A file missing from the kit falls back to the stock one: `favicon.ico` to `favicon-32.png`, `icon-192.png` to `pwa-192.png`, `icon-512.png` to `pwa-512.png`, the rest to the same name. A missing `logo.svg` is a 404. Kit files go out with `nosniff` and `Cache-Control: no-cache`, kit SVGs also with a sandboxing `Content-Security-Policy`.

`/manifest.webmanifest` (`opencode/pwa-manifest-routes.js`) uses the brand name as its default, though a stored PWA name or a `pwa_name` query still wins. `background_color` and `theme_color` take the default theme background. The icons are the kit's when it ships any of `icon-192.png`, `icon-512.png`, the 180 and 152 apple icons or `favicon.svg`. The inline fallback manifest in `index.html`, used only when that endpoint does not answer, keeps the stock icons and colours.

Only surfaces that load the page from this server are branded, which means web and hosted mobile. Electron, VS Code, the Capacitor app and the Vite dev server ship their own `index.html` and stay stock. The slot image serves the web UI only.

### Default themes

Both sides seed them, or the stock ids would come back. The UI uses them when the runtime has no stored theme preference (`contexts/theme-storage.ts`). The server writes them into settings when it migrates settings that have no theme ids yet (`defaultThemeIds` in `opencode/settings-runtime.js`), because the bootstrap settings sync would otherwise hand the UI the stock ids. A stored preference always wins, whether the user picked it or it was seeded earlier, so changing the variables later does not move existing installs. Deleting the selected imported theme falls back to the brand default of that variant, not to the stock one.

### Budget

`GET /api/multichamber/budget` sits in the `parsed` stage, behind the UI auth gate. The server fetches `MULTICHAMBER_BUDGET_URL` (GET, `accept: application/json`, 5 s timeout, 64 KiB cap), validates the JSON and answers with:

```json
{ "state": "ok", "weekly_percent_used": 44.2, "resets_at": "2026-10-11T12:00:00.000Z", "pack_percent_used": null, "has_topup": false }
```

- `state` is one of `ok`, `warn80`, `warn95`, `exhausted`. The UI colours and banners follow it, not the percent.
- Percents may be null and are clamped to 0..100. Upstream reports more than 100 on overdraw.
- `resets_at` may be null. Any date `Date.parse` accepts comes back as ISO UTC; anything else fails the payload.
- `has_topup` defaults to false. The UI ignores it, the top-up action follows `MULTICHAMBER_TOPUP_URL`.

Any upstream failure (network, timeout, non-2xx, oversize, not JSON, wrong shape) answers `502 { error: 'budget_unavailable' }` and logs at most one warning a minute, without the URL. A success is cached for 3 s and concurrent requests share one upstream call. Failures are not cached. Without the variable the route answers `404 { error: 'budget_not_configured' }`; it is registered anyway so the request never falls through to the OpenCode proxy.

### UI

Components live in `packages/ui/src/components/multichamber/`, state in `lib/multichamber/{brand,budget}.ts`, and the strings for every locale, Russian included, in `lib/i18n/messages/multichamber.i18n.ts`.

- The budget polls every 60 s while the page is visible, and on window focus. A failed or invalid answer hides every budget element. It never shows 0 %.
- Header: a pill "Budget 44%" (weekly percent, else pack percent, rounded down) with the reset countdown in a tooltip, then the account menu button. The pill is neutral for `ok`, uses the warning tokens for `warn80`, the error tokens for `warn95` and solid error for `exhausted`.
- Under the header (desktop `MainLayout`, mobile `MobileApp`): `warn80` and `warn95` banners with "Top up" and a dismiss that lasts for the browser session. The dismissal is stored in sessionStorage per state and reset time, so the next level or the next week shows again. `exhausted` gets a panel that cannot be dismissed, with "Top up" and "Change plan".
- Phones have no room in the header. The workspace drawer (`MobileWorkspaceDrawer.tsx`) shows a row with the pill, the countdown and the account menu.

Upstream files with white-label hooks, to keep when merging upstream: server `index.js`, `opencode/static-routes-runtime.js`, `opencode/pwa-manifest-routes.js` and `opencode/settings-runtime.js`; UI `Header.tsx`, `MainLayout.tsx`, `MobileApp.tsx`, `MobileWorkspaceDrawer.tsx`, `OpenChamberLogo.tsx`, `useWindowTitle.ts`, `theme-storage.ts`, `ThemeSystemContext.tsx`, `SettingsView.tsx`, `SettingsWindow.tsx`, `OpenChamberPage.tsx`, `OpenChamberVisualSettings.tsx`, and one import plus one spread in each locale file under `lib/i18n/messages/`. The icon sprite gained `logout-box-r` through `bun run icons:generate`.
