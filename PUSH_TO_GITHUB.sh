#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/samhalegolf/GolfDaddy.git}"
BRANCH="${BRANCH:-main}"
MESSAGE="${MESSAGE:-Add Clarity Caddie Phase 1 beta report candidate}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Cloning $REPO_URL..."
git clone "$REPO_URL" "$WORK_DIR/repo"
cd "$WORK_DIR/repo"
git checkout "$BRANCH"

echo "Copying candidate files into repo..."
rsync -a --delete \
  --exclude='.git/' \
  --exclude='dist/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.netlify/' \
  --exclude='supabase/.temp/' \
  "$ROOT_DIR/" "$WORK_DIR/repo/"

chmod +x PUSH_TO_GITHUB.sh || true

echo "Running local build check..."
npm install
npm run build:netlify

echo "Committing changes..."
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "$MESSAGE"
fi

echo "Pushing to $BRANCH..."
git push origin "$BRANCH"

echo "Done: $REPO_URL"
