#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-https://github.com/the-trvlr/yomiyasui.git}"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Git or use GitHub Desktop." >&2
  exit 1
fi

if [ ! -d .git ]; then git init -b main; fi
current_branch="$(git branch --show-current)"
if [ "$current_branch" != "main" ]; then git branch -M main; fi

git add .
if ! git diff --cached --quiet; then
  if ! git config user.name >/dev/null || ! git config user.email >/dev/null; then
    echo "Set your Git commit identity first." >&2
    exit 1
  fi
  git commit -m "Initial version of 読みやすい"
fi

if git remote get-url origin >/dev/null 2>&1; then
  existing="$(git remote get-url origin)"
  if [ "$existing" != "$REPO_URL" ]; then
    echo "Remote origin is already set to: $existing" >&2
    exit 1
  fi
else
  git remote add origin "$REPO_URL"
fi

git push -u origin main
