#!/usr/bin/env bash
# Nightly covergen sweep for a box that already has the repos, their test
# dependencies, and local Postgres/Redis. Leaves a branch per repo with the
# accepted tests committed. Never pushes, never opens a PR.
#
# Usage: scripts/nightly-sweep.sh [repo ...]      (default: every repo in covergen.yaml)
# Env:   COVERGEN_LIMIT (files per repo, default 10)
#        COVERGEN_BRANCH_PREFIX (default covergen/nightly)
#        COVERGEN_DRY_RUN=1 to gate without writing or committing
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
limit="${COVERGEN_LIMIT:-10}"
prefix="${COVERGEN_BRANCH_PREFIX:-covergen/nightly}"
stamp="$(date +%Y-%m-%d)"
logdir="$here/.covergen/logs"
mkdir -p "$logdir"

repos=("$@")
if [ ${#repos[@]} -eq 0 ]; then
  while IFS= read -r repo; do
    repos+=("$repo")
  done < <(node -e 'const y=require("yaml");const c=y.parse(require("fs").readFileSync("covergen.yaml","utf8"));for(const r of c.repos)console.log(r.name)')
fi

root_of() { node -e 'const y=require("yaml");const p=require("path");const c=y.parse(require("fs").readFileSync("covergen.yaml","utf8"));const r=c.repos.find(r=>r.name===process.argv[1]);console.log(p.resolve(r.root))' "$1"; }

for repo in "${repos[@]}"; do
  root="$(root_of "$repo")"
  log="$logdir/$stamp-$repo.log"
  body="$logdir/$stamp-$repo.md"
  echo "== $repo ($root)"

  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    echo "   skipping: working tree not clean" | tee -a "$log"
    continue
  fi
  base_branch="$(git -C "$root" branch --show-current)"
  branch="$prefix/$stamp"
  if [ "${COVERGEN_DRY_RUN:-}" != "1" ]; then
    git -C "$root" checkout -q -B "$branch"
  fi

  set +e
  if [ "${COVERGEN_DRY_RUN:-}" = "1" ]; then
    node dist/cli.js sweep --repo "$repo" --limit "$limit" --dry-run >"$body" 2>"$log"
  else
    node dist/cli.js sweep --repo "$repo" --limit "$limit" >"$body" 2>"$log"
  fi
  code=$?
  set -e

  dry="${COVERGEN_DRY_RUN:-}"
  if [ "$code" -eq 0 ] && [ "$dry" = "1" ]; then
    echo "   dry run: $(head -1 "$body" | sed 's/^# covergen: //')"
  elif [ "$code" -eq 0 ]; then
    git -C "$root" add -A -- ':!.covergen'
    git -C "$root" -c user.name=covergen -c user.email=covergen@localhost commit -q -F "$body"
    echo "   committed accepted tests on $branch (not pushed)"
    git -C "$root" checkout -q "$base_branch"
  elif [ "$code" -eq 2 ]; then
    echo "   nothing accepted"
    [ "$dry" != "1" ] && git -C "$root" checkout -q "$base_branch" && git -C "$root" branch -q -D "$branch"
  else
    echo "   failed with exit $code, see $log"
    [ "$dry" != "1" ] && git -C "$root" checkout -q -- . && git -C "$root" checkout -q "$base_branch" && git -C "$root" branch -q -D "$branch"
  fi
done
echo "done. reports in $logdir"
