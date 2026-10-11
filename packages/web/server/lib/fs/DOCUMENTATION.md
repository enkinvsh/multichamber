# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/archive.js`: symlink-free directory walk (`measureDirectory`) and the streamed zip writer (`streamDirectoryZip`, `yazl`, imported lazily) behind `GET /api/fs/archive`.
- `packages/web/server/lib/fs/download-headers.js`: `Content-Disposition` attachment builder (ASCII fallback + RFC 5987 `filename*`) and the sandbox CSP for active content types.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/raw`
    - `GET /api/fs/archive`
    - `GET /api/fs/disk`
    - `GET /api/fs/stat`
    - `GET /api/fs/directory-stat`
    - `GET /api/fs/serve/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/upload`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
    - `GET /api/fs/git-dirs` — shallow nested git repository discovery for the
      Git tab (depth- and visit-capped readdir walk; `.git` directory, file, or
      symlink marks a repository boundary; junk directories and symlinks are
      never descended into)
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - The active project directory is validated with `fs.realpath`, so when the project root is itself a symlink the workspace base no longer matches the paths the client sends. Workspace resolution therefore retries against the raw directory the client requested (`requestedDirectory` from `resolveProjectDirectory`) before falling back to worktree roots. Symlinks are still resolved afterwards, and write/exec routes keep their canonical containment check against the resolved base.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

Both search and directory listing discard `git check-ignore` stderr at spawn.
They consume stdout for ignore matches. Never create an unread stderr pipe:
Git diagnostics can fill it and block the child indefinitely, so repeated
searches accumulate live Git processes. `git-process.test.js` exercises both
paths with real OS pipes, twelve concurrent checks, and 2 MiB of diagnostics
per child. Successful completion must preserve ignore filtering and reap all
twelve children.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Workspace checks accept, besides the active workspace and its worktrees, the **managed roots**: the OpenChamber config root and the managed chats root (`managedChatsRoot` dependency; `OPENCHAMBER_CHATS_DIR` upstream, default `<config root>/chats`). Chat worktrees may legitimately live outside every project workspace.
- `GET /api/fs/home` preserves `{ home, chatsRoot }` and adds `canonicalChatsRoot` and `canonicalLegacyChatsRoot`, resolved by the server's filesystem. If a root does not exist yet, it resolves the nearest existing ancestor and appends the missing segments, without creating directories. Errors resolving the configured root fail the request. A failed legacy lookup warns and omits only that optional alias, retaining exact legacy matching without blocking an accessible relocated root. Clients use confirmed aliases for exact membership while keeping the original roots as folder/scope identities. `chatsRoot` is the server-resolved managed chats root; clients must use it instead of joining `home` + the well-known segment (a relocated root does not contain that segment).
- Workspace authorization accepts both the configured managed paths and their filesystem-confirmed canonical roots. Canonical lookup runs only when lexical workspace/managed-root checks fail. One failed managed-root lookup cannot reject an independently authorized root or worktree. Path comparisons remain case-sensitive on POSIX: distinct Linux directories named `chats` and `Chats` never become aliases through string folding. Shared UI keeps exact root membership for classification and directory cleanup.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- `GET /api/fs/directory-stat?path=...` uses one `stat` without listing contents or resolving project topology. It follows the same authenticated directory-discovery path policy as `/api/fs/list`, including targets outside the active workspace. A directory returns `{ isDirectory: true }`; `ENOENT` returns `not-found`, and a file or `ENOTDIR` returns `not-directory`. Permission and other failures remain distinct from a missing path. VS Code explicitly returns 501, so the shared client treats its probe as unknown.
- Read-only routes authorize the requested path against the workspace before resolving symlinks. A symlink reached through the workspace may therefore target a file outside it, while a directly requested outside path still requires an exact-path grant. Write routes keep canonical-target boundary checks.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller's requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
- `POST /api/fs/upload` accepts one `application/octet-stream` body with `path` and optional `overwrite=true` / `onConflict=rename` query parameters. The body streams into a hidden same-directory temp file (`.<name>.upload-<uuid>`, name truncated to 64 chars) with a 100 MiB default cap configurable through `OPENCHAMBER_FS_UPLOAD_MAX_BYTES`; the cap is enforced from `Content-Length` and again while streaming, and failed or oversized uploads delete the temp file. Over the cap → `413 { error, reason: "file_too_large", limit }`. Before streaming, `statfs` on the destination parent must leave `OPENCHAMBER_FS_MIN_FREE_BYTES` (default 1 GiB) free after the declared size, otherwise `507 { error, reason: "insufficient_storage", free, required }` where `free = bavail * bsize` and `required = Content-Length + reserve` (a missing `Content-Length` counts as 0). New files commit through an atomic no-replace link, existing files return `409` unless overwrite is explicit, directory targets are rejected, and the destination parent resolves before writing so uploads cannot escape through workspace symlinks. `onConflict=rename` wins over `overwrite`: the commit link retries `name (2).ext`, `name (3).ext`, … (dotfiles and extension-less names get ` (N)` appended) until a free name is found, so concurrent uploads never replace each other. The response is `{ success: true, path }` with the final path in the caller's path space.
- `GET /api/fs/raw?path=…[&download=true][&directory=…]` streams the file from an open descriptor (`Content-Length` from `fstat`, the read stream is destroyed when the client disconnects). The project scope is read from the `directory` query parameter as well as the `x-opencode-directory` header, so a plain anchor navigation works. Every response carries `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. `image/svg+xml`, `text/html`, `application/xhtml+xml`, `text/xml`, `application/xml` additionally get `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`; PDFs do not, because Chrome's PDF viewer does not render under `sandbox`. `download=true` adds `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<pct>`; the ASCII fallback drops non-ASCII and control characters, replaces `"` and `\`, and becomes `download<ext>` when only an extension would remain.
- `GET /api/fs/archive?path=<dir>[&full=1][&check=1][&directory=…]` zips a workspace directory. One walk (never following symlinks; sockets, FIFOs and devices are skipped) collects files and sizes and stops as soon as `OPENCHAMBER_FS_ARCHIVE_MAX_BYTES` (uncompressed sum, default 2 GiB) or `OPENCHAMBER_FS_ARCHIVE_MAX_FILES` (default 100000) is exceeded → `413 { error, reason: "archive_too_large", bytes, limit, files, fileLimit }` (`bytes` is then a lower bound). Directories named `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `.pytest_cache`, `.mypy_cache`, `.gradle` are skipped at any depth unless `full=1`. `check=1` answers `{ path, bytes, files, limit, excluded }` (`excluded`: relative paths of skipped directories, at most 100). Otherwise the response streams `application/zip` named `<dirname>.zip`; entries are `<dirname>/<relative path>` with UTF-8 names, ZIP64 where needed, stored for already-compressed extensions and deflated otherwise. Files are opened one at a time with `O_NOFOLLOW | O_NONBLOCK` and read up to their walked size; a file that vanished or became unreadable before it was opened is skipped and counted in one warning per archive, but a read error after its entry header is written aborts the response. Only one archive builds per process (`429 { error, reason: "archive_busy" }`); the slot is released on success, error and client disconnect, and a disconnect stops the walk and the stream.
- `GET /api/fs/disk?path=…` returns `{ path, total, free, used }` in bytes from `statfs` (`free = bavail * bsize`, `used = (blocks - bfree) * bsize`). Like `directory-stat` it is not bound to the active workspace; MultiChamber's `fs-root-guard` bounds it.
