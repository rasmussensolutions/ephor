"""Prepare a reviewable upstream update without rewriting installation history."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

STATE = ".ephor-upstream.json"
# Configuration is deliberately immutable in automatic updates. Upstream changes
# to these files require a manual migration instead of guessing operator intent.
CONFIGS = ("wrangler.jsonc", "apps/worker/wrangler.jsonc")


def git(*args, check=True):
    return subprocess.run(["git", *args], check=check, capture_output=True)


def content(ref, path):
    result = git("show", f"{ref}:{path}", check=False)
    return result.stdout if result.returncode == 0 else None


def prepare(target):
    if not re.fullmatch(r"[0-9a-f]{40}", target):
        raise ValueError("Target must be an exact official commit SHA")
    if git("status", "--porcelain").stdout:
        raise ValueError("Working tree must be clean")
    state = json.loads(Path(STATE).read_text())
    base = state["commit"]
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("Invalid installed upstream version")
    if base == target:
        return False
    # Downgrades and unrelated targets cannot silently revert installed code.
    git("merge-base", "--is-ancestor", base, target)
    for path in CONFIGS:
        if content(base, path) != content(target, path):
            raise ValueError(f"Upstream changed {path}; a manual configuration migration is required")
    for path in git("ls-tree", "-r", "--name-only", base, "packages/api/migrations").stdout.decode().splitlines():
        if content(base, path) != content(target, path):
            raise ValueError(f"Existing migration changed or was removed: {path}")
    # Workflow updates need separate review/permissions. Preserve the hoster's
    # workflows and updater rather than asking for a broadly privileged PAT.
    protected = (".github/workflows", "scripts/update-ephor.py")
    with tempfile.TemporaryDirectory() as temp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(temp) / "index")}
        def index(*args, data=None):
            return subprocess.run(["git", *args], input=data, env=env,
                                  check=True, capture_output=True).stdout
        index("read-tree", target)
        paths = git("ls-tree", "-r", "--name-only", "-z", target, *protected).stdout
        if paths:
            index("update-index", "--force-remove", "-z", "--stdin", data=paths)
        entries = git("ls-tree", "-r", "-z", base, *protected).stdout
        if entries:
            index("update-index", "-z", "--index-info", data=entries)
        candidate = index("write-tree").decode().strip()
        # merge-tree accepts commits, so wrap the filtered tree in a local object.
        candidate = index("-c", "user.name=Ephor updater", "-c", "user.email=update@ephor.invalid",
                          "commit-tree", candidate, "-p", target, data=b"Update candidate\n").decode().strip()
    # Explicit merge-base supports deployment copies with an unrelated root commit.
    result = git("merge-tree", "--write-tree", f"--merge-base={base}", "HEAD", candidate, check=False)
    if result.returncode:
        # Don't print conflict contents: a hoster's private files may be involved.
        raise ValueError("Local changes conflict with this update. No files were changed; merge the update manually.")
    tree = result.stdout.decode().splitlines()[0]
    for path in CONFIGS:
        if content("HEAD", path) != content(tree, path):
            raise ValueError(f"Update would change installation settings in {path}")
    # All checks precede the only working-tree mutation.
    git("read-tree", "--reset", "-u", tree)
    Path(STATE).write_text(json.dumps({"commit": target}, indent=2) + "\n")
    git("add", STATE)
    return True


if __name__ == "__main__":
    try:
        changed = prepare(sys.argv[1])
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as f:
                f.write(f"changed={'true' if changed else 'false'}\n")
        print("Update prepared for review." if changed else "Already up to date.")
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Update stopped: {error}", file=sys.stderr)
        sys.exit(1)
