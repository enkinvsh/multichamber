# MultiChamber (v1 line)

[OpenChamber](https://github.com/openchamber/openchamber) packaged for hosting: one user per
container, a fixed set of models, nothing to configure in the browser.

This branch, `v1`, is OpenChamber **v1.24.2 on OpenCode 1.x** (OpenCode 1.18.31). It exists because
the oh-my-openagent (OMO) plugin only works on OpenCode
1.x. The 1.x line is frozen upstream, so this branch does not follow upstream releases; the 2.x
line lives on `main` and publishes `:latest`. All credit for the app goes to the OpenChamber and
OpenCode authors; the upstream README is [here](../README.md).

## What is different from upstream

- **Lockdown** (`MULTICHAMBER_LOCKDOWN=1`, on in the image): providers and models come only from the
  image's OpenCode config. Users cannot add providers or keys, MCP servers or plugins, and cannot
  touch tunnels, updates, integrations (GitHub, Linear), quotas, voice keys, remote hosts or
  instance settings. The server refuses those writes with `403`, and the UI hides every page and
  button that leads to them. OpenChamber 1.x has no enterprise mode, so this is our own code.
- **The UI stays in the home folder.** `MULTICHAMBER_FS_ROOT` (defaults to `$HOME`) refuses every API
  request that names a path outside it — the folder picker, file routes and project directories.
  This is a usability boundary; isolation comes from the container (non-root user, read-only root
  filesystem).
- **Runs on any x86-64 CPU**: baseline builds of Bun and OpenCode, so CPUs without AVX work.
- One OpenCode config for every user (`multichamber/opencode.json`) pointing at an OpenAI-compatible
  gateway.

Details: [`packages/web/server/lib/multichamber/DOCUMENTATION.md`](../packages/web/server/lib/multichamber/DOCUMENTATION.md).

## Run

```sh
docker run -d --name multichamber -p 3000:3000 \
  --read-only --tmpfs /tmp:exec,size=1g --cap-drop ALL --security-opt no-new-privileges \
  -v multichamber-home:/home/dev \
  -e MULTICHAMBER_LLM_BASE_URL=http://gateway:8317/v1 \
  -e MULTICHAMBER_LLM_KEY=... \
  -e OPENCHAMBER_UI_PASSWORD=... \
  ghcr.io/enkinvsh/multichamber:v1
```

Image tags: `v1` (latest build of this branch), `v1-<OpenChamber version>` (e.g. `v1-1.24.2`),
`sha-<commit>`.

| Variable | Meaning |
|---|---|
| `MULTICHAMBER_LLM_BASE_URL` | Gateway base URL used by every provider in `opencode.json` (required) |
| `MULTICHAMBER_LLM_KEY` | Gateway key (required) |
| `OPENCHAMBER_UI_PASSWORD` | Password for the web UI; without it the server refuses to listen on the network |
| `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN` | `true` to run without the UI password when an authenticating proxy sits in front |
| `MULTICHAMBER_FS_ROOT` | Folder the UI may use, default `$HOME` |
| `MULTICHAMBER_LOCKDOWN` | `1` (image default) locks provider/MCP/plugin/tunnel/update/integration settings; any other value turns lockdown off |
| `MULTICHAMBER_PORT` | Listen port, default `3000` |
| `OPENCODE_CONFIG` | Replace the bundled OpenCode config with your own file |

## Layout

- `multichamber/` — image, entrypoint, OpenCode config.
- `packages/web/server/lib/multichamber/` — our server code (guards, `GET /api/multichamber/policy`).
- `packages/ui/src/lib/multichamber/` — the UI lockdown flag.
- `.github/workflows/multichamber-*` — the only workflows; upstream ones are removed.

License: MIT, same as upstream (see [LICENSE](../LICENSE)).
