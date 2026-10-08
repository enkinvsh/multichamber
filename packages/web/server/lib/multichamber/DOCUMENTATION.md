# MultiChamber filesystem root guard

`fs-root-guard.js` keeps the UI inside one folder. Set `MULTICHAMBER_FS_ROOT` (for example `/home/dev`) and every `/api/` request that names a path outside it gets `403` with code `outside_fs_root`. Unset or blank: the guard is not mounted and nothing changes. It is mounted in `server/index.js` right after `spaceArchive.guard`.

What is checked (route prefixes match case-insensitively):

- Every `/api/` request: query `directory` and `location[directory]`, the `x-opencode-directory` header (URI-decoded the same way as `spaces/dispatcher.js`), and query `path` only when it is absolute (`/…` or `~…`). Relative `path` values on proxied OpenCode routes are relative to the project and pass.
- `/api/fs/*`: query `path` (relative too) and JSON body keys `path`, `oldPath`, `newPath`, `cwd`, `destinationPath`, `targetPath`, `directory`.
- `/api/projects*`: JSON body key `projectPath` (`PUT /api/projects/:projectId/config`, `projects/project-setup.js`).
- `POST /api/openchamber/directory`: JSON body key `path` (opens a folder as the project, `projects/routes.js`).

A value is expanded (`~` → home folder), resolved with `path.resolve`, and must equal the root or sit below it, so `/home/dev2` and `/home/dev/../etc` are refused.

This is a UX boundary, not a security boundary: the container (read-only rootfs, non-root user) is the security boundary; a symlink or the terminal can still reach outside.
