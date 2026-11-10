#!/usr/bin/env bash
#
# A release is made in three steps, in this order:
#
#   1. scripts/release.sh check     Checks that main is ready to publish.
#   2. npm publish                  Yours to run: it asks for your npm sign-in.
#   3. scripts/release.sh source    Tags the release and pushes it to the public repository.
#
# Work happens in the private repository (the `origin` remote). The public repository (the
# `public` remote) only ever receives main as it was released, as one fast-forward push with
# its tag: the same commits, never squashed and never forced. Step 3 runs after step 2 on
# purpose, so a fix is installable before its source is public.

set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "release: $1" >&2
  exit 1
}

version=$(node -p "require('./package.json').version")
tag="v$version"

ready() {
  [ "$(git branch --show-current)" = "main" ] || fail "switch to main first"
  [ -z "$(git status --porcelain)" ] || fail "commit or put away your changes first"
  git fetch --quiet origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main and origin/main differ: push or pull first"
}

case "${1:-}" in
  check)
    ready
    node -e "process.exit(require('./package.json').private ? 1 : 0)" ||
      fail "package.json still says \"private\": true"
    grep -q "^## $version " CHANGELOG.md || fail "CHANGELOG.md has no entry for $version"
    if npm view "sanity-plugin-stripe@$version" version >/dev/null 2>&1; then
      fail "$version is already on npm"
    fi
    pnpm install --frozen-lockfile
    pnpm build
    pnpm check
    npm pack --dry-run
    echo
    echo "release: $version is ready. Now run: npm publish"
    echo "release: then run: scripts/release.sh source"
    ;;
  source)
    ready
    npm view "sanity-plugin-stripe@$version" version >/dev/null 2>&1 ||
      fail "$version is not on npm yet: run npm publish first"
    git remote get-url public >/dev/null 2>&1 ||
      fail "there is no public remote: git remote add public <the public repository's address>"
    git rev-parse "$tag" >/dev/null 2>&1 || git tag -a "$tag" -m "$version"
    git push origin "$tag"
    # No --force: the public repository must already be an ancestor of what is released.
    git push public main "$tag"
    echo "release: $tag is public."
    ;;
  *)
    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
