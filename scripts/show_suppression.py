#!/usr/bin/env python3
"""Show current alert suppression state — read-only diagnostic.

Run with:
    cd /home/poly/Anthri-mon/api
    .venv/bin/python -m scripts.show_suppression

Or symlinked from the repo root.  Prints:
  - Open device_down alerts
  - For each, which OTHER alerts the engine would currently suppress under it
  - Any alerts whose suppressed_by_alert_id points at a non-existent or
    resolved parent (drift indicator)
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

# Path bootstrap so we can run from anywhere: try the repo layout first
# (script at <repo>/scripts/show_suppression.py → api code at <repo>/api),
# then ask systemd where the API service's WorkingDirectory is.
HERE = Path(__file__).resolve().parent
_REPO_API = HERE.parent / "api"
if _REPO_API.exists():
    sys.path.insert(0, str(_REPO_API))
else:
    try:
        import subprocess as _sub
        wd = _sub.run(
            ["systemctl", "show", "-p", "WorkingDirectory", "--value", "anthrimon-api"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        if wd and (Path(wd)).exists():
            sys.path.insert(0, wd)
    except Exception:
        pass


def _load_env_from_systemd() -> None:
    """Lift DB_* / JWT_* / ANTHRIMON_* env vars off the running API service so
    this script doesn't need its own config file.

    We read /proc/<pid>/environ instead of `systemctl show -p Environment`
    because systemd's unit-file escape sequences (e.g. `\\$` for a literal `$`)
    are visible in the latter but already interpreted in the live process's
    environment, so /proc gives us the values exactly as the API sees them.

    Silently no-ops if the service isn't running."""
    try:
        pid_out = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", "anthrimon-api"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        pid = int(pid_out)
        if pid <= 0:
            return
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            data = f.read()
    except (FileNotFoundError, PermissionError):
        return
    for entry in data.split(b"\x00"):
        if not entry or b"=" not in entry:
            continue
        k, v = entry.split(b"=", 1)
        os.environ.setdefault(k.decode("utf-8", "replace"),
                              v.decode("utf-8", "replace"))


_load_env_from_systemd()

from sqlalchemy import text  # noqa: E402

from backend.alerting.suppression import compute_suppression_map  # noqa: E402
from backend.database import AsyncSessionLocal  # noqa: E402


TENANT = os.environ.get("ANTHRIMON_TENANT", "00000000-0000-0000-0000-000000000001")


def _fmt_table(rows: list[tuple[str, ...]], headers: list[str]) -> str:
    if not rows:
        return "  (none)"
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    line = lambda r: "  " + "  ".join(c.ljust(widths[i]) for i, c in enumerate(r))
    out = [line(tuple(headers)), "  " + "  ".join("─" * w for w in widths)]
    out.extend(line(r) for r in rows)
    return "\n".join(out)


async def main() -> None:
    async with AsyncSessionLocal() as db:
        # ── Suppression map ────────────────────────────────────────────────
        sm = await compute_suppression_map(db, TENANT)
        # Build a name lookup
        name_rows = (await db.execute(text("""
            SELECT id::text, hostname FROM devices WHERE tenant_id = CAST(:t AS uuid)
        """), {"t": TENANT})).all()
        names = {r.id: r.hostname for r in name_rows}

        parent_lookup = (await db.execute(text("""
            SELECT a.id::text, a.device_id::text, ar.name, a.triggered_at
              FROM alerts a JOIN alert_rules ar ON ar.id = a.rule_id
             WHERE a.tenant_id = CAST(:t AS uuid)
               AND a.status IN ('open','acknowledged')
        """), {"t": TENANT})).all()
        parents = {p.id: p for p in parent_lookup}

        # ── 1. Open device_down alerts and who they're root cause for ────
        print()
        print("═" * 78)
        print(" OPEN device_down ALERTS  (potential parents)")
        print("═" * 78)
        device_downs = (await db.execute(text("""
            SELECT a.id::text, a.device_id::text, a.triggered_at
              FROM alerts a JOIN alert_rules ar ON ar.id = a.rule_id
             WHERE a.tenant_id = CAST(:t AS uuid)
               AND a.status IN ('open','acknowledged')
               AND ar.metric = 'device_down'
             ORDER BY a.triggered_at
        """), {"t": TENANT})).all()

        if not device_downs:
            print("  No open device_down alerts.")
        else:
            for d in device_downs:
                child_count = (await db.execute(text("""
                    SELECT COUNT(*) FROM alerts
                     WHERE suppressed_by_alert_id = CAST(:p AS uuid)
                       AND status = 'suppressed'
                """), {"p": d.id})).scalar_one()
                print(f"  • {names.get(d.device_id, d.device_id):20s}  "
                      f"triggered {d.triggered_at:%Y-%m-%d %H:%M:%S}  "
                      f"suppressing {child_count} child alert(s)")

        # ── 2. Computed suppression map ──────────────────────────────────
        print()
        print("═" * 78)
        print(" COMPUTED SUPPRESSION MAP  (what compute_suppression_map() says now)")
        print("═" * 78)
        print()
        print(" device_down on these devices is suppressed under a parent:")
        if not sm.device_down_parent:
            print("   (none — no device_down cascades active)")
        else:
            rows = []
            for did, parent_aid in sm.device_down_parent.items():
                p = parents.get(str(parent_aid))
                p_name = names.get(p.device_id, "?") if p else "?"
                rows.append((names.get(did, did), p_name,
                             p.triggered_at.strftime("%H:%M:%S") if p else "?"))
            print(_fmt_table(rows, ["child device", "parent device", "parent at"]))

        print()
        print(" non-device_down alerts on these devices are suppressed:")
        if not sm.other_alerts_parent:
            print("   (none — no cascades, no own-device collateral)")
        else:
            rows = []
            for did, parent_aid in sm.other_alerts_parent.items():
                p = parents.get(str(parent_aid))
                p_name = names.get(p.device_id, "?") if p else "?"
                kind = "topology-downstream" if did in sm.device_down_parent else "own-device"
                rows.append((names.get(did, did), p_name, kind))
            print(_fmt_table(rows, ["device", "parent device", "reason"]))

        # ── 3. Currently-suppressed alerts in the DB ─────────────────────
        print()
        print("═" * 78)
        print(" CURRENTLY SUPPRESSED ALERTS IN DB")
        print("═" * 78)
        suppressed = (await db.execute(text("""
            SELECT a.id::text AS id, a.device_id::text AS device_id,
                   a.suppressed_by_alert_id::text AS parent_id,
                   ar.metric, a.title
              FROM alerts a JOIN alert_rules ar ON ar.id = a.rule_id
             WHERE a.tenant_id = CAST(:t AS uuid) AND a.status = 'suppressed'
             ORDER BY a.triggered_at DESC
             LIMIT 50
        """), {"t": TENANT})).all()
        if not suppressed:
            print("  (none)")
        else:
            rows = []
            for s in suppressed:
                p_name = "?"
                if s.parent_id and s.parent_id in parents:
                    p_name = names.get(parents[s.parent_id].device_id, "?")
                rows.append((names.get(s.device_id, "?")[:18], s.metric[:18],
                             p_name[:18], s.title[:32]))
            print(_fmt_table(rows, ["device", "metric", "parent device", "title"]))

        # ── 4. Drift indicators ──────────────────────────────────────────
        orphans = (await db.execute(text("""
            SELECT COUNT(*) FROM alerts a
             WHERE a.tenant_id = CAST(:t AS uuid)
               AND a.status = 'suppressed'
               AND a.suppressed_by_alert_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM alerts p
                    WHERE p.id = a.suppressed_by_alert_id
                      AND p.status IN ('open','acknowledged')
               )
        """), {"t": TENANT})).scalar_one()
        print()
        print("═" * 78)
        print(" DRIFT INDICATORS")
        print("═" * 78)
        if orphans:
            print(f"  ⚠  {orphans} suppressed alert(s) point to parents that have "
                  f"been resolved. These should be unsuppressed on the next cycle "
                  f"(cascade-unsuppress). If they persist, that's a bug.")
        else:
            print("  ✓  All suppressed alerts have a live parent.")
        print()


if __name__ == "__main__":
    asyncio.run(main())
