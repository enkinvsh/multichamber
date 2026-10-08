#!/usr/bin/env bash
# Merge the newest upstream OpenChamber release tag (or the tag given as $1) into HEAD.
# Upstream workflows are dropped: only .github/workflows/multichamber-* belong to this repo.
# Any other conflict aborts the merge and fails, so a broken patch shows up as a red run.
set -euo pipefail

upstream_url="${UPSTREAM_URL:-https://github.com/openchamber/openchamber.git}"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$upstream_url"
git fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/v*'

tag="${1:-$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1)}"
output="${GITHUB_OUTPUT:-/dev/null}"

if git merge-base --is-ancestor "$tag" HEAD; then
  echo "already up to date with $tag"
  echo "merged=" >>"$output"
  exit 0
fi

git merge --no-ff --no-commit "$tag" || true

for file in .github/workflows/*; do
  [ -e "$file" ] || continue
  case "$(basename "$file")" in
    multichamber-*) ;;
    *) git rm -q -f -- "$file" ;;
  esac
done
# Workflows upstream changed but this repo deleted come back as unmerged entries without a file.
git diff --name-only --diff-filter=U -- .github/workflows | { grep -v '/multichamber-' || true; } | xargs -r git rm -q -f --

conflicts="$(git diff --name-only --diff-filter=U)"
if [ -n "$conflicts" ]; then
  echo "merge of $tag conflicts with our patches:" >&2
  echo "$conflicts" >&2
  git merge --abort
  exit 1
fi

# Follow the Bun and OpenCode versions the upstream image pins.
bun_version="$(sed -n 's/^FROM oven\/bun:\([0-9][0-9.]*\).*/\1/p' Dockerfile | head -n 1)"
opencode_version="$(grep -o '@opencode/cli@[0-9][0-9.]*' Dockerfile | head -n 1 | cut -d@ -f3)"
if [ -n "$bun_version" ] && [ -n "$opencode_version" ]; then
  perl -pi -e "s/^ARG BUN_VERSION=.*/ARG BUN_VERSION=$bun_version/; s/^ARG OPENCODE_VERSION=.*/ARG OPENCODE_VERSION=$opencode_version/" multichamber/Dockerfile
  echo "$bun_version" >multichamber/.bun-version
  git add multichamber/Dockerfile multichamber/.bun-version
else
  echo "could not read Bun/OpenCode versions from upstream Dockerfile" >&2
  git merge --abort
  exit 1
fi

git commit -q -m "chore: merge upstream $tag"
echo "merged $tag (bun $bun_version, opencode $opencode_version)"
echo "merged=$tag" >>"$output"
