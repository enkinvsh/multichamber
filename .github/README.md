# MultiChamber

[OpenChamber](https://github.com/openchamber/openchamber) packaged for hosting: one user per
container, a fixed set of models, nothing to configure in the browser.

This repository follows upstream OpenChamber release tags. A scheduled job merges each new
release, rebuilds the image and publishes it to `ghcr.io/enkinvsh/multichamber`. All credit for the
app goes to the OpenChamber and OpenCode authors; the upstream README is [here](../README.md).

## What is different from upstream

- **Enterprise mode is always on** (`multichamber/policy.json`): providers come only from the
  image's OpenCode config, users cannot add keys or providers, no tunnels, no third-party extensions.
- **The UI stays in the home folder.** `MULTICHAMBER_FS_ROOT` (defaults to `$HOME`) refuses every API
  request that names a path outside it — the folder picker, file routes and project directories
  (`packages/web/server/lib/multichamber/`). This is a usability boundary; isolation comes from the
  container (non-root user, read-only root filesystem).
- **Runs on any x86-64 CPU**: baseline builds of Bun and OpenCode, so CPUs without AVX2 work.
- One OpenCode config for every user (`multichamber/opencode.json`) pointing at an OpenAI/Anthropic-
  compatible gateway.

## Run

```sh
docker run -d --name multichamber -p 3000:3000 \
  --read-only --tmpfs /tmp:exec,size=1g --cap-drop ALL --security-opt no-new-privileges \
  -v multichamber-home:/home/dev \
  -e MULTICHAMBER_LLM_BASE_URL=http://gateway:8317/v1 \
  -e MULTICHAMBER_LLM_KEY=... \
  -e OPENCHAMBER_UI_PASSWORD=... \
  ghcr.io/enkinvsh/multichamber:latest
```

| Variable | Meaning |
|---|---|
| `MULTICHAMBER_LLM_BASE_URL` | Gateway base URL used by every provider in `opencode.json` (required) |
| `MULTICHAMBER_LLM_KEY` | Gateway key (required) |
| `OPENCHAMBER_UI_PASSWORD` | Password for the web UI |
| `MULTICHAMBER_FS_ROOT` | Folder the UI may use, default `$HOME` |
| `OPENCODE_CONFIG` | Replace the bundled OpenCode config with your own file |

## Layout

- `multichamber/` — image, entrypoint, policy, OpenCode config, upstream sync script.
- `packages/web/server/lib/multichamber/` — the only server code that is ours.
- `.github/workflows/multichamber-*` — the only workflows; upstream ones are removed on every merge.

License: MIT, same as upstream (see [LICENSE](../LICENSE)).
