#!/bin/sh
# Release gates for a local checkout: run from the repository root after `npm ci`.
# Tests, lint, the production build and the Hermes plugin's Python tests, then whitespace errors in every committed file and in pending changes.
set -eu
npm test
npm run lint
npm run build
python3 -m unittest discover hermes-plugins/steam-frame-view/tests
if git rev-parse --verify --quiet HEAD >/dev/null; then
  git diff --check "$(git hash-object -t tree /dev/null)" HEAD
fi
git diff --check
git diff --cached --check
echo 'All release gates passed.'
