#!/usr/bin/env bash
#
# Materialize immutable, self-contained agent skill snapshots for Azure builds.
#
# Usage:
#   scripts/sync-agent-skills.sh
#   scripts/sync-agent-skills.sh --check
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/hosted-agent/skill-sources.lock"
DEST_SKILLS="$ROOT/hosted-agent/skills"
DEST_VENDOR="$ROOT/hosted-agent/vendor"
MODE="${1:-sync}"

if [[ "$MODE" != "sync" && "$MODE" != "--check" ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || {
  echo "git is required" >&2
  exit 1
}
[[ -f "$LOCK" ]] || {
  echo "missing lock file: $LOCK" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/bundle"
mkdir -p "$BUNDLE/skills" "$BUNDLE/vendor/licenses"

declare -A REPOSITORIES=()
declare -A COMMITS=()

while read -r name repository commit extra; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  if [[ -n "${extra:-}" || ! "$name" =~ ^[a-z0-9-]+$ ||
        ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ||
        ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid lock row: $name $repository $commit ${extra:-}" >&2
    exit 1
  fi
  if [[ -n "${REPOSITORIES[$name]:-}" ]]; then
    echo "duplicate source name in lock: $name" >&2
    exit 1
  fi
  REPOSITORIES[$name]="$repository"
  COMMITS[$name]="$commit"
done < "$LOCK"

for required in superclarity agent-maturity; do
  [[ -n "${REPOSITORIES[$required]:-}" ]] || {
    echo "missing required source in lock: $required" >&2
    exit 1
  }
done

clone_locked() {
  local name="$1"
  local repository="${REPOSITORIES[$name]}"
  local commit="${COMMITS[$name]}"
  local checkout="$WORK/sources/$name"

  mkdir -p "$checkout"
  git -C "$checkout" init --quiet
  git -C "$checkout" remote add origin "https://github.com/$repository.git"
  if ! git -C "$checkout" fetch --depth 1 --quiet origin "$commit"; then
    echo "unable to fetch locked skill source $repository@$commit; check GitHub credentials" >&2
    return 1
  fi
  if ! git -C "$checkout" checkout --detach --quiet FETCH_HEAD; then
    echo "unable to check out locked skill source $repository@$commit" >&2
    return 1
  fi
  [[ "$(git -C "$checkout" rev-parse HEAD)" == "$commit" ]] || {
    echo "resolved commit differs for $repository@$commit" >&2
    exit 1
  }
  printf '%s\n' "$checkout"
}

copy_skills() {
  local source_root="$1"
  local skill

  [[ -d "$source_root" ]] || {
    echo "missing skills directory: $source_root" >&2
    exit 1
  }
  for skill in "$source_root"/*; do
    [[ -f "$skill/SKILL.md" ]] || continue
    local name
    name="$(basename "$skill")"
    [[ ! -e "$BUNDLE/skills/$name" ]] || {
      echo "duplicate skill name across sources: $name" >&2
      exit 1
    }
    cp -a "$skill" "$BUNDLE/skills/$name"
  done
}

SUPERCLARITY_ROOT="$(clone_locked superclarity)"
MATURITY_ROOT="$(clone_locked agent-maturity)"
copy_skills "$SUPERCLARITY_ROOT/skills"
copy_skills "$MATURITY_ROOT/skills"

MATURITY_PACKAGE="$MATURITY_ROOT/src/agent_maturity"
[[ -f "$MATURITY_PACKAGE/__init__.py" && -d "$MATURITY_PACKAGE/mcp" ]] || {
  echo "agent maturity Python package is incomplete" >&2
  exit 1
}
mkdir -p "$BUNDLE/vendor/agent-maturity"
cp -a "$MATURITY_PACKAGE" "$BUNDLE/vendor/agent-maturity/agent_maturity"

# Match the upstream copy installer: every maturity skill carries its Python
# package and shared references, so CLI fallbacks work without MCP or PYTHONPATH.
for skill in "$BUNDLE/skills"/agent-maturity-*; do
  mkdir -p "$skill/_lib" "$skill/scripts"
  cp -a "$MATURITY_PACKAGE" "$skill/_lib/agent_maturity"
  if [[ ! -d "$skill/references" ]]; then
    cp -a \
      "$MATURITY_ROOT/skills/agent-maturity-assess/references" \
      "$skill/references"
  fi
  cat > "$skill/scripts/amx.py" <<'PY'
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "_lib"))

from agent_maturity.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
PY
done

cp "$SUPERCLARITY_ROOT/LICENSE" "$BUNDLE/vendor/licenses/superclarity-LICENSE"
cp "$MATURITY_ROOT/LICENSE" "$BUNDLE/vendor/licenses/agent-maturity-LICENSE"
{
  echo "# Immutable upstream snapshots bundled into the Hosted Agent image."
  for name in superclarity agent-maturity; do
    echo "${REPOSITORIES[$name]}@${COMMITS[$name]}"
  done
} > "$BUNDLE/vendor/PROVENANCE.txt"

skill_count="$(
  find "$BUNDLE/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' '
)"
[[ "$skill_count" -gt 0 ]] || {
  echo "no skills materialized from the locked sources" >&2
  exit 1
}

# The runtime cross-checks this manifest on startup, so a source that stops
# publishing a skill fails the container instead of silently shrinking what the
# agent can do.
{
  echo "# Skills baked into the Hosted Agent image. Generated; do not edit."
  find "$BUNDLE/skills" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
} > "$BUNDLE/skills/.manifest"

if [[ "$MODE" == "--check" ]]; then
  diff -qr "$BUNDLE/skills" "$DEST_SKILLS" >/dev/null || {
    echo "tracked skills differ from locked sources" >&2
    exit 1
  }
  diff -qr "$BUNDLE/vendor" "$DEST_VENDOR" >/dev/null || {
    echo "tracked vendor package differs from locked sources" >&2
    exit 1
  }
  echo "Skill bundle matches locked sources"
  exit 0
fi

rm -rf "$DEST_SKILLS" "$DEST_VENDOR"
mv "$BUNDLE/skills" "$DEST_SKILLS"
mv "$BUNDLE/vendor" "$DEST_VENDOR"
echo "Synced $skill_count self-contained skills from locked sources"
