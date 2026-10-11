# MultiChamber (v1 line: OpenChamber 1.24.2 on OpenCode 1.x)

Everything MultiChamber adds to the server lives here. `install.js` is the entry point for the guards and API routes; `server/index.js` calls it twice:

- `installMultichamber(app, 'early')` right after `app.use(compression(...))`, before `bootstrapRuntime.setupBaseRoutes`. Mounts the lockdown guard, `GET /api/multichamber/policy` and `/api/multichamber/activity`. It has to precede `setupBaseRoutes` because `/api/system/*`, `/auth/passkey/*`, `/api/client-auth/*`, `/api/passkeys` and `/api/openchamber/update-install` are registered there, some before the UI auth gate.
- `installMultichamber(app, 'parsed')` right after `uiAuthController = bootstrapResult.uiAuthController`. The JSON body parsers (`core-routes.js` `registerCommonRequestMiddleware`) are installed inside `setupBaseRoutes`, and the fs, settings and projects routes (`featureRoutesRuntime`) and the OpenCode proxy (`startupPipelineRuntime`) come after this point. Mounts the settings key filter, the filesystem root guard, the project guard and `GET /api/multichamber/budget`.

The white label (`brand.js`) plugs into the theme, settings and static-file runtimes, so `server/index.js` creates it directly; see [White label](#white-label).

The host guard (`host-guard.js`) is created directly in `server/index.js` as well, because it must run before everything else; see [Host guard](#host-guard).

The preview proxy is a separate `node` child process (`preview-proxy-main.js`, supervised by `preview-proxy-process.js`) started from `server/index.js` after the startup pipeline; see [Preview proxy](#preview-proxy).

1.x has no enterprise mode, so there is no `enterprise-mode.js` and no `policy.json`.

## Host guard

`host-guard.js` protects the server against DNS rebinding and cross-site requests. In zeny the agent drives a Chromium inside the same container, and port 3000 has no UI login on the LAN (`OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true`), so any page the agent opens could rebind its own domain to `127.0.0.1` or simply POST / open a WebSocket to `localhost:3000`. Chromium Local Network Access is not relied on.

Enabled only when `MULTICHAMBER_ALLOWED_HOSTS` is set: comma-separated hostnames, no ports, case-insensitive (zeny sets `app.ai.meybz.asia`). Parsed once at startup. Unset or blank: nothing is installed and the server behaves exactly as stock.

Wiring in `server/index.js`: `hostGuard.middleware` is the first `app.use` (right after `app.set('trust proxy', true)`, before `X-Robots-Tag`, CORS, compression, the lockdown guard, UI auth, body parsers and static files). `hostGuard.installOnServer(server)` runs right after `http.createServer(app)` and wraps `server.emit` so a rejected `upgrade` never reaches any `server.on('upgrade')` listener (terminal, dictation, event stream, realtime proxy, dev tunnel, and any added later). Node calls every `upgrade` listener, so a rejecting listener alone would not stop the others. The stock `isRequestOriginAllowed` checks in those handlers still run after it.

Rules:

1. Host (every request and upgrade). `Host`, or `:authority` when missing; port, IPv6 brackets and one trailing dot stripped; lowercased. Allowed: an IPv4/IPv6 literal (DNS rebinding cannot produce one), `localhost`, `*.localhost`, or an exact allowlist entry. Otherwise `421 Misdirected Request`, `text/plain` body `Host not allowed`, no CORS headers. Upgrades get a raw `HTTP/1.1 421 Misdirected Request` and the socket is destroyed.
2. Cross-site (POST, PUT, PATCH, DELETE and every upgrade). `Sec-Fetch-Site: cross-site` → `403 Cross-site request blocked`. An `Origin` header must be same-origin (`URL.host` equals the already-checked `Host` header) or an `https:` origin whose hostname is in the allowlist; `Origin: null` or anything else → 403. No `Origin` and no `Sec-Fetch-Site` → allowed (the OpenCode plugin, curl, the slot heartbeat, orchestrator health checks). GET/HEAD/OPTIONS skip this step: CORS already keeps a foreign page from reading the response.

Each rejection is logged with `console.warn` at most once a minute per (reason, host).

Legit zeny callers that pass: the master Caddy (`Host: app.ai.meybz.asia`, Caddy keeps the client's Host by default; browser `Origin: https://app.ai.meybz.asia`), orchestrator `GET http://10.77.x.y:3000/health`, the heartbeat `GET http://127.0.0.1:3000/api/multichamber/activity`, the OpenCode plugin POSTing to `localhost` without `Origin`, and the agent's Chromium on `http://localhost:3000` (same-origin).

## Policy endpoint

`GET /api/multichamber/policy` returns `{ lockdown: boolean, fsRoot: string | null, previewOpenUrl: string | null, dictation: boolean }` (`lockdown` is `MULTICHAMBER_LOCKDOWN === '1'`, `fsRoot` is the trimmed `MULTICHAMBER_FS_ROOT`, `previewOpenUrl` is `MULTICHAMBER_PREVIEW_OPEN_URL` when it is an absolute `https:` URL without credentials, else `null`; the UI treats a missing field as `null`; `dictation` is true when managed STT is configured — `MULTICHAMBER_STT_BASE_URL`, see `managed-stt.js` and `../dictation/DOCUMENTATION.md` — and lets the locked-down composer show the mic; the UI treats a missing field as `false`). The UI reads it once (`packages/ui/src/lib/multichamber/lockdown.ts`); a `404` means a plain OpenChamber server and leaves everything unlocked.

## Preview proxy

`preview-proxy.js` (request handling) serves the private dev-server preview inside the container. zeny's master Caddy authenticates the owner and forwards `https://<port>-<key>.<preview domain>` via DNAT to `MULTICHAMBER_PREVIEW_PORT`, adding `X-Zeny-Preview-Port: <port>`. This listener is the second layer: the agent's Chromium in the same container can reach it directly (or by DNS rebinding), so it must grant nothing beyond what `127.0.0.1:<port>` already gives.

Env (both required, otherwise nothing listens and the server behaves as stock):

- `MULTICHAMBER_PREVIEW_PORT`: port of the proxy's `http.Server`, bound to `0.0.0.0` (zeny: `47801`). Not behind the host guard, which only wraps the `:3000` server.
- `MULTICHAMBER_PREVIEW_NODE` (optional): `node` binary for the child, a path or a name looked up in `PATH`; default `node` from `PATH`. Not found → one warning, preview off, the main server unaffected.
- `MULTICHAMBER_PREVIEW_DOMAIN`: preview domain `P` (trimmed, lowercased, one trailing dot dropped; must be a plain hostname).
- `MULTICHAMBER_PREVIEW_OPEN_URL` (UI only, see [Policy endpoint](#policy-endpoint)): master URL that opens a preview, e.g. `https://ai.meybz.asia/api/preview/open`.

Per request and upgrade:

1. `X-Zeny-Preview-Port` must be digits and `Host` (port stripped, not lowercased) must match `^([1-9][0-9]{3,4})-([a-z2-7]{12})\.P$` with the captured port equal to the header; else `421` with a short `text/plain` body. A request target that is not origin-form (`/…`) gets `400`.
2. Denied ports get `403` with a small HTML page and are never contacted: below `1024`, `22`, `47765` (zeny agent), the preview port itself, the server's own port (configured and active tunnel port) and the managed OpenCode port (`openCodePort` in `server/index.js`). This list is computed when the child is (re)spawned; a tunnel port that changes later reaches the child only on its next restart, but every port of the server process is also closed by the owner rule below (on Linux), and under `MULTICHAMBER_LOCKDOWN` tunnels are off.
3. Connect `127.0.0.1:<port>` (10 s timeout), on `ECONNREFUSED` retry `::1:<port>`. Nothing listening → `502` with the HTML page «На порту N ничего не запущено» (no scripts, no external resources). On Linux an owner lookup runs in parallel (`createListenPortOwnerResolver` in `dev-server-ownership.js`): the pids holding a LISTEN socket on that port (any local address in `/proc/net/tcp` and `tcp6`, inode → `/proc/<pid>/fd/*` `socket:[inode]`), plus every `opencode serve` ancestor directly above an `opencode serve` owner (the npm launcher wrapper around the real binary). The port gets `403` after the connect (so «nothing running» stays a 502 page) when an owner is the multichamber server (the child's `process.ppid` at start and `MULTICHAMBER_PREVIEW_PARENT_PID`), the proxy itself, or any `opencode serve` process (`/proc/<pid>/cmdline`, `createOpenCodeServeCheck`; OpenCode owns several random loopback ports besides its API). The child has no IPC to the server, so it cannot tell the managed OpenCode from a second `opencode serve` the agent started; both are refused. Everything else is proxied: dev servers reparented to PID 1 (`nohup … &`, `npm run dev &`, tmux), descendants, root-owned `docker-proxy`. The proxy deliberately does not use the discovery filter, whose descendant rule would refuse those orphans. Allowed answers are cached for 5 s per port, refusals are not cached. A failed lookup is logged and the request proxied; without `/proc` (macOS, dev) only the static list of step 2 applies.
4. Forwarded with `Host: localhost:<port>`, `Origin: http://localhost:<port>` (only when the client sent one), `X-Forwarded-Host: <public host>`, `X-Forwarded-Proto: https`, `X-Forwarded-For` appended; `X-Zeny-Preview-Port` and hop-by-hop headers removed. A `Location` pointing at `http://(localhost|127.0.0.1|0.0.0.0|[::1]):<same port>/…` becomes `https://<public host>/…`.
5. Bodies are piped both ways (no buffering). WebSocket upgrades are rewritten the same way and then piped as raw sockets; they get no idle timeout (HMR sockets stay silent for hours), only TCP keepalive. Plain HTTP sockets close after 5 min idle. A client abort destroys the upstream request and vice versa; errors are logged and never crash the process.

Process model. The slot runs the server under Bun (`bun …/bin/cli.js serve`), and Bun 1.3's `node:http` ignores `createConnection` on the client and never hands out the raw socket on `upgrade` (measured 2026-10-11: every GET/POST was a 502 `ECONNREFUSED`, redirects hung, WebSockets got no answer). So `startPreviewProxy` (`preview-proxy-process.js`, called from `server/index.js`) runs the proxy as a child `node preview-proxy-main.js` (the image installs Debian `nodejs` 20; the script path is resolved from `import.meta.url`, `/opt/multichamber/packages/web/server/lib/multichamber/` in the slot). Details:

- Child env is minimal: `PATH`, `HOME`, `NODE_ENV`, `LANG`, plus `MULTICHAMBER_PREVIEW_PORT`, `MULTICHAMBER_PREVIEW_DOMAIN`, `MULTICHAMBER_PREVIEW_DENIED_PORTS` (comma list: the preview port, the server port, the active tunnel port, `openCodePort`) and `MULTICHAMBER_PREVIEW_PARENT_PID`. Secrets of the server env (`MULTICHAMBER_LLM_KEY`, …) are not passed.
- Child stdout/stderr lines go to the server log with a `[preview-proxy]` prefix. `startPreviewProxy` waits up to 10 s for the `listening on 0.0.0.0:<port>` line.
- An unexpected exit restarts the child after 1 s, doubling up to 30 s; a child that ran at least a minute restarts after 1 s again.
- `stop()` in `server/index.js` sends `SIGTERM`, waits for the exit (`SIGKILL` after 5 s), so the port is free when it resolves.
- No orphans: the server holds the child's stdin pipe; EOF (server died, even by `SIGKILL`) or a changed `process.ppid` (checked every 2 s) makes the child close and exit. On a normal server exit a `process.on('exit')` hook also sends `SIGTERM`.

Smoke test of the real spawn path (not part of vitest; needs `node` in `PATH` or `MULTICHAMBER_PREVIEW_NODE`; uses random ports 50000–59000, never `47801`), run from the repo root with each parent runtime:

```
bun packages/web/server/lib/multichamber/preview-proxy.smoke.mjs
node packages/web/server/lib/multichamber/preview-proxy.smoke.mjs
```

It exits `0` only if GET (upstream sees `Host`/`Origin` rewritten), POST body, `Location` rewrite, `421` on header/Host mismatch and missing header, `403` on a denied port, the `502` page, a WebSocket `101` + echo with `Sec-WebSocket-Protocol: vite-hmr` reaching upstream, a restart after `SIGKILL` of the child, and a dead child plus a free port after `stop()` all hold. On Linux it also checks the owner rule on a port held by the parent and that the child's `/proc/<pid>/environ` holds only the allowed variables.

UI: `lib/multichamber/browser.ts` `openMultichamberPreview` turns a loopback URL with an explicit port into `<previewOpenUrl>?port=<port>&path=<path+query+hash, encoded>` and opens it as a new top-level tab (anchor click, `rel="noopener noreferrer"`). The chat preview button tooltip says so (`multichamber.preview.openPrivate`). Without `previewOpenUrl` the loopback toast stays.

## User activity

`activity.js` tells the host when the user last touched the UI, so the host can put an idle machine to sleep. An open tab alone keeps sending background traffic (WebSocket pings, push visibility, session and budget polling), so connections and bytes cannot tell an idle tab from a working one; only real input can.

- `POST /api/multichamber/activity` stores `Date.now()` in memory and answers `204`.
- `GET /api/multichamber/activity` answers `{ "last_input_at": "<ISO UTC>" | null }` with `Cache-Control: no-store`; `null` until the first report since the server started.
- Only in lockdown. Otherwise both answer `404 { error: 'activity_not_enabled' }`, registered so they never fall through to the OpenCode proxy.
- Registered in the `early` stage, before the UI auth gate: the slot host reads it without a user session.

The UI side is `packages/ui/src/hooks/useMultichamberActivityBeacon.ts`, mounted once in `App.tsx`. Once the server reports lockdown it listens for `pointerdown`, `keydown`, `wheel` and `touchstart` on `window` (capture, passive) and posts at most once a minute; the first input posts at once. It has no timer, so a tab nobody touches sends nothing.

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

A blocked request gets `403 { error: 'This setting is managed by MultiChamber.', code: 'multichamber_locked' }`, even before login. GET status reads the UI makes at startup or while polling (`/api/guests`, `/api/linear/auth/status`, `/api/github/auth/status`, `/api/quota/providers`, tunnel/relay status) stay open; the UI stops rendering the features instead.

The two update checks never leave the container: in lockdown `installMultichamber(app, 'early')` registers `GET /api/openchamber/update-check` and `GET /api/opencode/upgrade-status` ahead of the stock routes, and both answer `{ available: false }`. The stock handlers would ask `api.openchamber.dev` (with usage data), npm and GitHub; the operator updates by shipping a new image instead.

`RULES` (prefix match on segments, `*` = one segment):

- Writes (anything but GET/HEAD/OPTIONS): `/api/provider`, `/api/auth` (except `POST /api/auth/reset`, the OpenChamber sign-out), `/api/config` (exact: OpenCode `PATCH /config`), `/api/global/config`, `/api/mcp`, `/api/config/mcp`, `/api/config/plugins`, `/api/behavior/agents-md`, `/api/quota`, `/api/openchamber/tunnel`, `/api/openchamber/relay`, `/api/guests`, `/api/routing`, `/api/client-auth`, `/api/passkeys`, `/api/linear`, `/api/github/auth`, `/api/voice`, `/api/tts`, `/api/dictation/models`, `/api/experimental/console`, and OpenCode's v2 `/api/credential`, `/api/integration` (reachable as `/api/api/...` through the proxy, both forms are listed).
- Every method: `/api/provider/*/oauth`, `/api/global/upgrade`, `/api/config/skills/install`, `/api/config/skills/scan`, `/api/quota/credentials`, `/api/openchamber/update-install`, `/api/opencode/upgrade`, `/api/system/shutdown`, `/api/system/dev-shutdown`, `/api/guests/*/oauth`, `/auth/passkey/register`, `/linear/oauth`, `/mcp/oauth`, `/api/dictation/models/*/download`.
- Paths are lowercased, segments decoded (a decoded `/` or `\` splits again), empty segments ignored. An undecodable path or a `.`/`..` segment under `/api`, `/auth`, `/linear` or `/mcp` is refused.

`createLockdownSettingsFilter` does not block `PUT /api/config/settings` (theme and chat preferences save through it); it deletes the keys in `LOCKDOWN_DENIED_SETTINGS` from the body: every `scope: "instance"` key of `opencode/settings-registry.json` except `ALLOWED_INSTANCE_SETTINGS` (workspace/UI keys such as `projects`, `lastDirectory`, `pinnedDirectories`, session retention, `openInAppId`). New upstream instance keys are denied by default. `opencodeBinary` is denied so the image's `OPENCODE_BINARY` stays in force.

Not locked on the server: the dictation WebSocket (`/api/dictation/ws`) is an `upgrade` handler, not an Express route, and the local STT model downloads on its first use; the UI hides dictation in lockdown instead. `POST /api/system/probe-url` stays open because the dev-server preview uses it.

Session sharing (`POST|DELETE /api/session/:id/share`, also `/api/api/...`) is refused as a write; share is off in the slot config.

### Projects (`project-guard.js`)

A fresh home starts with one project, `~/projects`: the container entrypoint (`multichamber/entrypoint.sh`) writes `settings.json` with `lastDirectory` when the file does not exist, and the stock settings migration turns it into the first project. Without a project the UI never reloads providers (`loadProviders` skips an unknown directory), so a browser cache from an older image would keep stale model capabilities.

Mounted in the `parsed` stage after the fs root guard, lockdown only. Root = `MULTICHAMBER_FS_ROOT`, or the home folder when unset. A project path must sit strictly below the root, and no segment below the root may start with `.` (`~/.omo`, `~/.config`, `~/.local/share` hold harness state). The check runs on the `~`-expanded path and again on its `realpath`, so a symlink into a hidden folder is refused too.

Routes that add projects or move the active directory (all other `persistSettings` callers only edit existing project entries, such as `project-icon-routes.js`):

- `POST /api/opencode/directory` (adds/creates a project, sets `activeProjectId` and `lastDirectory`): a forbidden `path` gets `403 { error: 'This folder cannot be a project.', code: 'multichamber_locked' }`; a blank one reaches the route's own `400`.
- `PUT /api/config/settings`: forbidden `projects` entries are stripped, `activeProjectId` is dropped when it named one, and a forbidden `lastDirectory` is dropped. `lastDirectory` may also point into OpenCode worktrees (`$XDG_DATA_HOME|~/.local/share` + `/opencode/worktree`).

On a successful answer of either route the guard runs `git init` (no commit) in each accepted project that `git rev-parse --is-inside-work-tree` does not report as a work tree, before the JSON goes out, so the Git, Changes and Walkthrough panels work at once. Each directory is checked once per process; a failed `git init` logs a warning and the project add still succeeds.

### Dev-server discovery (`dev-server-ownership.js`)

`createMultichamberDevServerFilter` is passed to `createDevServerScanner({ filterServers })` in `server/index.js`. In lockdown on Linux it keeps a listening port only when its socket inode (from `/proc/net/tcp(6)`) is held, per `/proc/<pid>/fd`, by a strict descendant of the OpenChamber process (parents from `/proc/<pid>/stat`). Ports held by the managed `opencode serve` (pid from the lifecycle module, or any `opencode … serve` command line between it and this server) are dropped, as are ports with no resolvable owner (the harness memory server, other users). Dev servers an agent or a terminal starts are descendants and stay. The same scanner feeds the dev tunnel allowlist, so dropped ports are not tunnelled either.

UI side (`packages/ui/src/lib/multichamber/lockdown.ts`): `useMultichamberLockdown()`; `MULTICHAMBER_LOCKED_SETTINGS_PAGES` in `lib/settings/metadata.ts` leave the nav, search and command palette, deep links fall back to the first visible page; provider/MCP/usage/update/integration/dictation/open-in-app entry points are hidden. The policy fetch starts at bootstrap (`main.tsx`, `renderMobileApp.tsx`); while it is pending the web runtime treats lockdown as on (fail-closed), and a failed fetch means unlocked (a server without the route is not MultiChamber). Also hidden in lockdown: About (sidebar footer, Electron menu), Share/Unshare/copy share link (session menus), the Linear and PR context panels (rail, panel chooser, number keys; persisted tabs are closed), the Usage and MCP rows in "Choose sections", multi-run (sidebar button, palette, message action), the hidden-folders toggle in the directory picker, and the `toggle-memory-debug` palette command (`lib/multichamber/{commands,panels,work-status}.ts`).

Browser panel (lockdown): hidden like Linear and PR (`'browser'` in `LOCKED_CONTEXT_MODES`: rail, panel chooser, number keys, `openContextSurface`/`openContextPanelTab` refuse it). Persisted browser tabs are closed once the policy has loaded with lockdown on (`useMultichamberLockdownConfirmed`, so the fail-closed guess on an unlocked server never closes tabs); until then the panel just does not mount them. Why: the panel frames pages in the user's own browser, so `http://localhost:8123` from a dev server started in the slot points at the user's machine, not the container (the dev tunnel in `lib/browser/devTunnel.ts` only exists in Electron), and most external sites refuse to be framed. URL openers (preview buttons in chat messages and markdown, the terminal's preview button) go through `lib/multichamber/browser.ts` from `openContextPreview`: a non-loopback http(s) URL opens in a new tab (`noopener,noreferrer`), a loopback URL shows the info toast `contextPanel.browser.toast.workspacePreviewUnavailable`, anything else is ignored. Project actions are hidden as well: the header's Auto-discover / "Choose project action" split button (`Header.tsx`) and the Actions section of project settings (`ProjectSettingsPanel.tsx`). Without a preview they could only end in a "No dev server command found" toast or a terminal run with nothing to open; dev servers still start from the terminal or through the agent. The agent's `browser.open` has no opener registered, so agent browser control goes unanswered (the agent sees a timeout). When the policy carries `previewOpenUrl`, loopback URLs (preview buttons and plain chat links) open the private preview in a new tab instead of the toast (see [Preview proxy](#preview-proxy)); the panel itself stays hidden until it can frame the preview.

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
- Five optional fields come from newer gateways and are passed through only when upstream sends them, so an older gateway gets exactly the answer above. `fallback_percent_used` is the percent of the fallback model's allowance used, clamped like the others. `stopped` is a boolean: true when the gateway rejects requests. `preset` is `economy`, `balance` or `maximum`; any other value becomes null instead of failing the payload. `renews` is a boolean: false means `resets_at` is the end of the paid subscription, not the start of a new period. `byok` is a boolean: true on an own-key tariff, which has no budget at all. They have to be listed in the schema, because zod drops unknown keys and the browser would never see them.

Any upstream failure (network, timeout, non-2xx, oversize, not JSON, wrong shape) answers `502 { error: 'budget_unavailable' }` and logs at most one warning a minute, without the URL. A success is cached for 3 s and concurrent requests share one upstream call. Failures are not cached. Without the variable the route answers `404 { error: 'budget_not_configured' }`; it is registered anyway so the request never falls through to the OpenCode proxy.

### UI

Components live in `packages/ui/src/components/multichamber/`, state in `lib/multichamber/{brand,budget}.ts`, and the strings for every locale, Russian included, in `lib/i18n/messages/multichamber.i18n.ts`.

- The budget polls every 60 s while the page is visible, and on window focus. A failed or invalid answer hides every budget element. It never shows 0 %.
- Header: a pill "Budget 44%" (weekly percent, else pack percent, rounded down) with the reset countdown in a tooltip, then the account menu button. The pill is neutral for `ok`, uses the warning tokens for `warn80`, the error tokens for `warn95` and solid error for `exhausted`.
- Under the header (desktop `MainLayout`, mobile `MobileApp`): `warn80` and `warn95` banners with "Top up" and a dismiss that lasts for the browser session. The dismissal is stored in sessionStorage per state and reset time, so the next level or the next week shows again. `exhausted` gets a panel that cannot be dismissed, with "Top up" and "Change plan".
- `stopped` matters more than `state` (`getMultichamberBudgetMode`). `stopped === true` is the stop mode: the panel says agents are paused. `exhausted` with `stopped === false` is the fallback mode: the budget is spent but agents keep working on the fallback model, and the pill and panel show `fallback_percent_used` when it is known. An older gateway sends no `stopped`, so its `exhausted` keeps the old stop behaviour. `preset` is parsed but not shown.
- `byok === true` wins over everything and is the `hidden` mode: no pill, no banner, no countdown in the drawer, because an own-key tariff has no budget. `renews === false` (`getMultichamberBudgetResetKeys`) switches the countdown, the fallback banner and the stop panel to texts that say when the plan ends and ask to renew it in the account (`endsIn`, `fallbackEnds`, `stoppedEnds`). Without `renews` (older gateway) the refresh texts stay.
- Phones have no room in the header. The workspace drawer (`MobileWorkspaceDrawer.tsx`) shows a row with the pill, the countdown and the account menu.

Upstream files with white-label hooks, to keep when merging upstream: server `index.js`, `opencode/static-routes-runtime.js`, `opencode/pwa-manifest-routes.js` and `opencode/settings-runtime.js`; UI `Header.tsx`, `MainLayout.tsx`, `MobileApp.tsx`, `MobileWorkspaceDrawer.tsx`, `OpenChamberLogo.tsx`, `useWindowTitle.ts`, `theme-storage.ts`, `ThemeSystemContext.tsx`, `SettingsView.tsx`, `SettingsWindow.tsx`, `OpenChamberPage.tsx`, `OpenChamberVisualSettings.tsx`, and one import plus one spread in each locale file under `lib/i18n/messages/`. The icon sprite gained `logout-box-r` through `bun run icons:generate`.
