#!/usr/bin/env bash
# Leak check for a public repository: fails when tracked files, commit messages,
# or supplied pull request text match a private list of names that must never
# appear here. The list lives outside the repository so the repository itself
# never carries it. The pattern is never printed, only the lines that matched.
#
# Usage: scripts/leak-check.sh
# Env:   LEAK_PATTERNS       extended regex, case insensitive, matched as is
#        LEAK_PATTERNS_FILE  file of patterns, one per line, blank lines and
#                            lines starting with # ignored, joined with |
#                            (default: $HOME/.config/covergen/leak-patterns)
#        LEAK_BASE           git rev: also scan commit messages in $LEAK_BASE..HEAD
#        LEAK_TEXT           extra text to scan, for example a pull request title
#                            and body passed through the environment
#
# Exit 0 when nothing matched or when no pattern is configured, which is how a
# fork without the secret passes. Exit 1 on any hit.
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

patterns_file="${LEAK_PATTERNS_FILE:-$HOME/.config/covergen/leak-patterns}"
pattern="${LEAK_PATTERNS:-}"

if [ -z "$pattern" ] && [ -f "$patterns_file" ]; then
  pattern="$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$patterns_file" | paste -sd '|' -)"
fi

if [ -z "$pattern" ]; then
  echo "leak-check: no pattern configured, skipping"
  exit 0
fi

hits=0

# Prints matched lines under a heading and records that the run failed. The
# pattern itself never reaches the output, only the lines that contained it.
report() {
  local heading="$1"
  local found="$2"
  if [ -n "$found" ]; then
    hits=1
    echo "leak-check: $heading"
    printf '%s\n' "$found"
  fi
}

# Tracked files. package-lock.json is excluded: it is generated, enormous, and
# its registry URLs are not authored text. -I skips binaries, -H keeps the file
# name on every line even when xargs hands grep a single file.
filelist="$(mktemp)"
trap 'rm -f "$filelist"' EXIT
git ls-files -z -- . ':(exclude)package-lock.json' > "$filelist"
if [ -s "$filelist" ]; then
  tracked="$(xargs -0 grep -inIHE -- "$pattern" < "$filelist" 2>/dev/null)"
  report "tracked files" "$tracked"
fi

# Commit messages added on this branch.
if [ -n "${LEAK_BASE:-}" ]; then
  if git rev-parse --verify --quiet "$LEAK_BASE" >/dev/null; then
    commits="$(git log --format=%B "$LEAK_BASE..HEAD" | grep -inE -- "$pattern")"
    report "commit messages in $LEAK_BASE..HEAD" "$commits"
  else
    echo "leak-check: $LEAK_BASE is not a known revision, skipping commit messages"
  fi
fi

# Pull request title and body, or any other text CI wants scanned.
if [ -n "${LEAK_TEXT:-}" ]; then
  text="$(printf '%s\n' "$LEAK_TEXT" | grep -inE -- "$pattern")"
  report "supplied text" "$text"
fi

if [ "$hits" -ne 0 ]; then
  echo "leak-check: failed. Remove the names above, or fix the pattern list if this is a false positive."
  exit 1
fi

echo "leak-check: clean"
exit 0
