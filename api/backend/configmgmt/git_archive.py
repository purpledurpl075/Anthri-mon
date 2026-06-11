"""Git-backed config archive.

Each tenant gets a local git repo at /var/lib/anthrimon/config-archive/<tenant_id>/
with one file per device under configs/.  Every changed config backup is
committed to that repo, giving a portable history independent of Postgres.
If a remote is configured (stored encrypted in TenantSetting.settings
["config_git"]), each commit is followed by a best-effort `git push`.

All git operations are best-effort: failures are logged and never raised
into the backup-storage path.
"""
from __future__ import annotations

import asyncio
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crypto
from ..models.alert import AuditLog
from ..models.device import Device
from ..models.settings import TenantSetting
from ..models.tenant import User

logger = structlog.get_logger(__name__)

_ARCHIVE_ROOT = Path("/var/lib/anthrimon/config-archive")
_GIT_TIMEOUT = 30
_PUSH_TIMEOUT = 30

_LOG_SEP = "\x1f"  # unit separator — unlikely to appear in commit text
_REC_SEP = "\x1e"  # record separator
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")
_HASH_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")


def _repo_path(tenant_id) -> Path:
    return _ARCHIVE_ROOT / str(tenant_id)


def _run_git(repo: Path, *args: str, timeout: int = _GIT_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _ensure_repo(tenant_id) -> Path:
    repo = _repo_path(tenant_id)
    (repo / "configs").mkdir(parents=True, exist_ok=True)
    if not (repo / ".git").exists():
        _run_git(repo, "init")
        _run_git(repo, "config", "user.name", "Anthrimon Config Archive")
        _run_git(repo, "config", "user.email", "anthrimon@localhost")
        _run_git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
    return repo


def _filename_for(dev: Device) -> str:
    safe_host = _SAFE_CHARS.sub("_", dev.hostname or "device")
    return f"configs/{safe_host}__{str(dev.id)[:8]}.cfg"


# ── Attribution ──────────────────────────────────────────────────────────────

async def _triggered_by(db: AsyncSession, dev: Device) -> str:
    """Best-effort 'who changed this' string for the commit body.

    Looks for a recent config_push audit row for this device (written by the
    deploy/rollback endpoints) and attributes the commit to that user/action.
    Falls back to "periodic poll" if nothing recent is found.
    """
    # audit_log.created_at is TIMESTAMP WITHOUT TIME ZONE (naive UTC); strip
    # tzinfo so asyncpg can compare it (see routers/audit.py _naive_utc).
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=120)).replace(tzinfo=None)
    row = (await db.execute(
        select(AuditLog.new_value, User.username)
        .outerjoin(User, User.id == AuditLog.user_id)
        .where(
            AuditLog.resource_type == "device",
            AuditLog.resource_id == dev.id,
            AuditLog.action == "config_push",
            AuditLog.created_at >= cutoff,
        )
        .order_by(AuditLog.created_at.desc())
        .limit(1)
    )).first()
    if row is None:
        return "periodic poll"
    new_value, username = row
    action = (new_value or {}).get("action", "deploy")
    return f"{username or 'unknown'} ({action})"


# ── Remote config (TenantSetting.settings["config_git"]) ─────────────────────

async def _get_tenant_setting(db: AsyncSession, tenant_id) -> TenantSetting:
    ts = (await db.execute(
        select(TenantSetting).where(TenantSetting.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if ts is None:
        ts = TenantSetting(tenant_id=tenant_id, settings={})
        db.add(ts)
        await db.flush()
    return ts


async def get_git_config(db: AsyncSession, tenant_id) -> dict:
    ts = (await db.execute(
        select(TenantSetting).where(TenantSetting.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if ts is None:
        return {}
    return dict((ts.settings or {}).get("config_git") or {})


async def _save_git_config(db: AsyncSession, tenant_id, cfg: dict) -> None:
    ts = await _get_tenant_setting(db, tenant_id)
    settings = dict(ts.settings or {})
    settings["config_git"] = cfg
    ts.settings = settings
    await db.commit()


async def set_remote(db: AsyncSession, tenant_id, remote_url: str, branch: str = "main") -> None:
    """Persist (encrypted) remote config and configure the repo's `origin`."""
    cfg = await get_git_config(db, tenant_id)
    if crypto.is_configured():
        cfg["remote_url"] = crypto.encrypt(remote_url)
        cfg["remote_url_encrypted"] = True
    else:
        cfg["remote_url"] = remote_url
        cfg["remote_url_encrypted"] = False
        logger.warning("git_archive_remote_unencrypted", tenant_id=str(tenant_id))
    cfg["branch"] = branch
    cfg["last_push_ok"] = None
    cfg["last_push_error"] = None
    cfg["last_push_at"] = None
    await _save_git_config(db, tenant_id, cfg)

    repo = _ensure_repo(tenant_id)
    _run_git(repo, "remote", "remove", "origin")
    _run_git(repo, "remote", "add", "origin", remote_url)


async def remove_remote(db: AsyncSession, tenant_id) -> None:
    cfg = await get_git_config(db, tenant_id)
    cfg.pop("remote_url", None)
    cfg.pop("remote_url_encrypted", None)
    cfg["last_push_ok"] = None
    cfg["last_push_error"] = None
    cfg["last_push_at"] = None
    await _save_git_config(db, tenant_id, cfg)

    repo = _repo_path(tenant_id)
    if (repo / ".git").exists():
        _run_git(repo, "remote", "remove", "origin")


def _mask_remote_url(url: str) -> str:
    """Strip embedded userinfo (user:pass@ or token@) from a remote URL for display."""
    return re.sub(r"//[^@/]+@", "//", url)


async def _record_push_result(db: AsyncSession, tenant_id, ok: bool, error: Optional[str]) -> None:
    cfg = await get_git_config(db, tenant_id)
    cfg["last_push_at"] = datetime.now(timezone.utc).isoformat()
    cfg["last_push_ok"] = ok
    cfg["last_push_error"] = error
    await _save_git_config(db, tenant_id, cfg)


async def _do_push(db: AsyncSession, tenant_id, repo: Path, branch: str) -> dict:
    push = await asyncio.to_thread(_run_git, repo, "push", "origin", branch, timeout=_PUSH_TIMEOUT)
    ok = push.returncode == 0
    error = None if ok else (push.stderr.strip()[:500] or push.stdout.strip()[:500] or "git push failed")
    await _record_push_result(db, tenant_id, ok, error)
    if not ok:
        logger.warning("git_archive_push_failed", tenant_id=str(tenant_id), error=error)
    return {"ok": ok, "error": error}


async def push_now(db: AsyncSession, tenant_id) -> dict:
    repo = _repo_path(tenant_id)
    if not (repo / ".git").exists():
        return {"ok": False, "error": "Archive repository does not exist yet"}
    cfg = await get_git_config(db, tenant_id)
    if not cfg.get("remote_url"):
        return {"ok": False, "error": "No remote configured"}
    return await _do_push(db, tenant_id, repo, cfg.get("branch", "main"))


# ── Commit on backup change ───────────────────────────────────────────────────

async def commit_config(
    db: AsyncSession,
    dev: Device,
    config_text: str,
    lines_added: int,
    lines_removed: int,
    backup_id: str,
    method: str,
    is_first: bool,
) -> Optional[str]:
    """Write *config_text* to the tenant's archive repo and commit it.

    Returns the new commit hash, or None if there was nothing to commit (the
    file content didn't actually change) or the git operation failed.
    """
    try:
        repo = _ensure_repo(dev.tenant_id)
        rel_path = _filename_for(dev)
        (repo / rel_path).write_text(config_text)

        status = _run_git(repo, "status", "--porcelain", "--", rel_path)
        if not status.stdout.strip():
            return None

        add = _run_git(repo, "add", "--", rel_path)
        if add.returncode != 0:
            logger.warning("git_archive_add_failed", device=dev.hostname, error=add.stderr.strip())
            return None

        triggered_by = await _triggered_by(db, dev)
        if is_first:
            subject = f"{dev.display_name}: initial snapshot"
        else:
            subject = f"{dev.display_name}: +{lines_added} -{lines_removed} lines"
        message = f"{subject}\n\nBackup-Id: {backup_id}\nSource: {method}\nTriggered-by: {triggered_by}"

        commit = _run_git(repo, "commit", "-m", message)
        if commit.returncode != 0:
            combined = (commit.stdout + commit.stderr).lower()
            if "nothing to commit" in combined:
                return None
            logger.warning("git_archive_commit_failed", device=dev.hostname, error=commit.stderr.strip())
            return None

        rev = _run_git(repo, "rev-parse", "HEAD")
        commit_hash = rev.stdout.strip() or None

        cfg = await get_git_config(db, dev.tenant_id)
        if cfg.get("remote_url"):
            await _do_push(db, dev.tenant_id, repo, cfg.get("branch", "main"))

        return commit_hash
    except Exception as exc:
        logger.warning("git_archive_commit_exception", device=dev.hostname, error=str(exc))
        return None


# ── History / browsing ────────────────────────────────────────────────────────

async def get_log(tenant_id, dev: Device, limit: int = 50) -> list[dict]:
    repo = _repo_path(tenant_id)
    if not (repo / ".git").exists():
        return []
    rel_path = _filename_for(dev)
    fmt = f"%H{_LOG_SEP}%aI{_LOG_SEP}%s{_LOG_SEP}%b{_REC_SEP}"
    result = _run_git(repo, "log", f"--max-count={limit}", "--follow", f"--format={fmt}", "--", rel_path)
    if result.returncode != 0:
        return []

    entries = []
    for rec in result.stdout.split(_REC_SEP):
        rec = rec.strip("\n")
        if not rec:
            continue
        parts = rec.split(_LOG_SEP)
        if len(parts) < 4:
            continue
        commit_hash, date, subject, body = parts[0], parts[1], parts[2], parts[3]
        entries.append({"hash": commit_hash, "date": date, "subject": subject, "body": body.strip()})
    return entries


async def get_file_at_commit(tenant_id, dev: Device, commit_hash: str) -> Optional[str]:
    repo = _repo_path(tenant_id)
    if not (repo / ".git").exists():
        return None
    if not _HASH_RE.match(commit_hash):
        return None
    rel_path = _filename_for(dev)
    result = _run_git(repo, "show", f"{commit_hash}:{rel_path}")
    if result.returncode != 0:
        return None
    return result.stdout


# ── Status ─────────────────────────────────────────────────────────────────────

async def repo_status(db: AsyncSession, tenant_id) -> dict:
    repo = _repo_path(tenant_id)
    cfg = await get_git_config(db, tenant_id)

    remote_url_masked = None
    raw_url = cfg.get("remote_url")
    if raw_url:
        try:
            raw = crypto.decrypt(raw_url) if cfg.get("remote_url_encrypted") else raw_url
            remote_url_masked = _mask_remote_url(raw)
        except Exception:
            remote_url_masked = "(unavailable)"

    out = {
        "exists": (repo / ".git").exists(),
        "commit_count": 0,
        "last_commit": None,
        "remote_configured": bool(raw_url),
        "remote_url_masked": remote_url_masked,
        "branch": cfg.get("branch", "main"),
        "last_push_at": cfg.get("last_push_at"),
        "last_push_ok": cfg.get("last_push_ok"),
        "last_push_error": cfg.get("last_push_error"),
    }
    if not out["exists"]:
        return out

    count = _run_git(repo, "rev-list", "--count", "HEAD")
    if count.returncode == 0 and count.stdout.strip():
        out["commit_count"] = int(count.stdout.strip())

    fmt = f"%H{_LOG_SEP}%aI{_LOG_SEP}%s"
    last = _run_git(repo, "log", "-1", f"--format={fmt}")
    if last.returncode == 0 and last.stdout.strip():
        parts = last.stdout.strip().split(_LOG_SEP)
        if len(parts) == 3:
            out["last_commit"] = {"hash": parts[0], "date": parts[1], "subject": parts[2]}

    return out
