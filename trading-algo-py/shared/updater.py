"""Auto-update system — checks GitHub for new versions and pulls updates.

Usage:
    from shared.updater import check_for_updates, auto_update

    # Check only (returns info dict)
    info = check_for_updates()

    # Auto-download and apply update
    updated = auto_update()
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

# Version is the single source of truth from pyproject.toml
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_PYPROJECT = _PROJECT_ROOT / "pyproject.toml"
_UPDATE_CHECK_FILE = _PROJECT_ROOT / "data" / ".last_update_check"

# GitHub repo
GITHUB_OWNER = os.environ.get("GITHUB_OWNER", "Bigwar6868")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "Lmao")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

# Check interval: once per hour
CHECK_INTERVAL_S = int(os.environ.get("UPDATE_CHECK_INTERVAL", "3600"))


@dataclass
class UpdateInfo:
    """Result of an update check."""
    current_version: str
    latest_version: str | None
    latest_commit: str | None
    latest_commit_message: str | None
    update_available: bool
    checked_at: int
    error: str | None = None


def get_current_version() -> str:
    """Read current version from pyproject.toml."""
    try:
        text = _PYPROJECT.read_text()
        for line in text.splitlines():
            if line.strip().startswith("version"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return "0.0.0"


def get_local_commit() -> str | None:
    """Get the current local git commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=str(_PROJECT_ROOT.parent),
        )
        if result.returncode == 0:
            return result.stdout.strip()[:12]
    except Exception:
        pass
    return None


def _should_check() -> bool:
    """Rate-limit: only check once per CHECK_INTERVAL_S."""
    try:
        if _UPDATE_CHECK_FILE.exists():
            last_check = int(_UPDATE_CHECK_FILE.read_text().strip())
            if time.time() - last_check < CHECK_INTERVAL_S:
                return False
    except Exception:
        pass
    return True


def _record_check() -> None:
    """Record the timestamp of this check."""
    try:
        _UPDATE_CHECK_FILE.parent.mkdir(parents=True, exist_ok=True)
        _UPDATE_CHECK_FILE.write_text(str(int(time.time())))
    except Exception:
        pass


def check_for_updates(force: bool = False) -> UpdateInfo:
    """Check GitHub for a newer version.

    Checks:
    1. GitHub Releases API for tagged versions (e.g. v2.1.0)
    2. Latest commit on the branch for code updates

    Returns UpdateInfo with current vs latest version.
    """
    current = get_current_version()
    local_commit = get_local_commit()
    now = int(time.time())

    if not force and not _should_check():
        return UpdateInfo(
            current_version=current,
            latest_version=None,
            latest_commit=local_commit,
            latest_commit_message=None,
            update_available=False,
            checked_at=now,
            error="Skipped (checked recently)",
        )

    headers = {"Accept": "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"token {GITHUB_TOKEN}"

    latest_version = current
    latest_commit = None
    latest_message = None
    update_available = False
    error = None

    try:
        with httpx.Client(timeout=10) as client:
            # 1. Check latest release
            try:
                resp = client.get(
                    f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest",
                    headers=headers,
                )
                if resp.status_code == 200:
                    release = resp.json()
                    tag = release.get("tag_name", "")
                    latest_version = tag.lstrip("v")
                    if _version_gt(latest_version, current):
                        update_available = True
                        log.info("New release available: %s → %s", current, latest_version)
            except Exception:
                pass  # No releases — check commits instead

            # 2. Check latest commit on branch
            try:
                resp = client.get(
                    f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/commits/{GITHUB_BRANCH}",
                    headers=headers,
                )
                if resp.status_code == 200:
                    commit = resp.json()
                    latest_commit = commit.get("sha", "")[:12]
                    latest_message = commit.get("commit", {}).get("message", "").split("\n")[0]

                    if local_commit and latest_commit != local_commit:
                        update_available = True
                        log.info("New commit: %s → %s (%s)", local_commit, latest_commit, latest_message)
            except Exception:
                pass

    except Exception as e:
        error = str(e)
        log.warning("Update check failed: %s", e)

    _record_check()

    return UpdateInfo(
        current_version=current,
        latest_version=latest_version,
        latest_commit=latest_commit,
        latest_commit_message=latest_message,
        update_available=update_available,
        checked_at=now,
        error=error,
    )


def auto_update(force: bool = False) -> bool:
    """Check for updates and auto-pull if available.

    Steps:
    1. Check GitHub for newer version/commit
    2. git fetch + git pull to download changes
    3. pip install -r requirements.txt if requirements changed
    4. Return True if updated, False otherwise
    """
    info = check_for_updates(force=force)

    if not info.update_available:
        if info.error and "Skipped" not in (info.error or ""):
            log.warning("Update check error: %s", info.error)
        else:
            log.info("Already up to date (v%s)", info.current_version)
        return False

    log.info("Downloading update: v%s → v%s (commit: %s)",
             info.current_version, info.latest_version or "?", info.latest_commit or "?")

    repo_root = str(_PROJECT_ROOT.parent)

    # Step 1: git fetch
    try:
        result = subprocess.run(
            ["git", "fetch", "origin", GITHUB_BRANCH],
            capture_output=True, text=True, timeout=30,
            cwd=repo_root,
        )
        if result.returncode != 0:
            log.error("git fetch failed: %s", result.stderr)
            return False
    except Exception as e:
        log.error("git fetch error: %s", e)
        return False

    # Step 2: git pull (fast-forward only to avoid conflicts)
    try:
        result = subprocess.run(
            ["git", "pull", "--ff-only", "origin", GITHUB_BRANCH],
            capture_output=True, text=True, timeout=30,
            cwd=repo_root,
        )
        if result.returncode != 0:
            log.error("git pull failed: %s", result.stderr)
            log.info("Try manual: git pull origin %s", GITHUB_BRANCH)
            return False
        log.info("git pull: %s", result.stdout.strip().split("\n")[-1])
    except Exception as e:
        log.error("git pull error: %s", e)
        return False

    # Step 3: Check if requirements changed and reinstall
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD~1", "--name-only"],
            capture_output=True, text=True, timeout=10,
            cwd=repo_root,
        )
        changed_files = result.stdout.strip().split("\n") if result.returncode == 0 else []

        if any("requirements" in f for f in changed_files):
            log.info("requirements.txt changed — reinstalling dependencies...")
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r",
                 str(_PROJECT_ROOT / "requirements.txt"), "-q"],
                timeout=120,
                cwd=str(_PROJECT_ROOT),
            )
            log.info("Dependencies updated")
    except Exception as e:
        log.warning("Dependency update check failed: %s", e)

    new_version = get_current_version()
    new_commit = get_local_commit()
    log.info("Updated to v%s (commit: %s)", new_version, new_commit or "?")

    return True


def format_update_status(info: UpdateInfo) -> str:
    """Format update info for display."""
    lines = [f"Version: v{info.current_version}"]

    if info.latest_commit:
        lines.append(f"Latest commit: {info.latest_commit}")
    if info.latest_commit_message:
        lines.append(f"  → {info.latest_commit_message}")

    if info.update_available:
        if info.latest_version and info.latest_version != info.current_version:
            lines.append(f"Update available: v{info.current_version} → v{info.latest_version}")
        else:
            lines.append("New commits available")
        lines.append("Run: python -m shared.updater")
    else:
        lines.append("Up to date")

    if info.error and "Skipped" not in info.error:
        lines.append(f"Warning: {info.error}")

    return "\n".join(lines)


def _version_gt(a: str, b: str) -> bool:
    """Compare semver strings: is a > b?"""
    try:
        va = [int(x) for x in a.split(".")[:3]]
        vb = [int(x) for x in b.split(".")[:3]]
        while len(va) < 3:
            va.append(0)
        while len(vb) < 3:
            vb.append(0)
        return va > vb
    except (ValueError, IndexError):
        return a > b


# CLI: python -m shared.updater
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if "--check" in sys.argv:
        info = check_for_updates(force=True)
        print(format_update_status(info))
    else:
        print(f"Current: v{get_current_version()} (commit: {get_local_commit() or '?'})")
        print("Checking for updates...")
        updated = auto_update(force=True)
        if updated:
            print("Updated successfully! Restart the system to use the new version.")
        else:
            print("No updates available.")
