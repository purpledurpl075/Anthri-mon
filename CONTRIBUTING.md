# Contributing to Anthrimon

First off — thanks. Even a one-line bug report helps.

This document is short on purpose. It covers the things you need to know to make a useful contribution; it doesn't try to be a complete style guide.

## TL;DR

1. Open an issue first for anything bigger than a typo or one-file bugfix. Saves both sides time.
2. Branch off `main`. Keep PRs focused on a single concern.
3. Sign your commits off (`git commit -s`) — see [Developer Certificate of Origin](#dco) below.
4. Make sure the API loads (`python -c "import backend.main"`), the SNMP collector compiles (`go build ./...` in `collectors/snmp/`), and the frontend builds (`npm run build`) before opening the PR. CI will check the same.
5. Match the surrounding code's style. No bikeshedding rules — see [Code style](#code-style).

## What this project is

A self-hosted network monitoring platform: SNMP polling, NetFlow/sFlow/IPFIX ingest, syslog, SNMP traps, config management, alerting, topology, remote-collector federation over WireGuard. Target audience is network engineers running their own infrastructure.

What we want help with:
- **Bug fixes** — always welcome.
- **New device-vendor support** — see existing implementations in `collectors/snmp/internal/vendor/` and `api/backend/configmgmt/`.
- **Documentation** — particularly the operator-facing parts (`WIKI.md`, troubleshooting recipes).
- **Test coverage** — we lean integration over unit.
- **Performance improvements** with a measured before/after.

What we're cautious about:
- Large refactors without a discussed plan.
- New abstractions added "for future flexibility" without a concrete current need.
- New optional configuration knobs that complicate the install.

## Getting set up

The fastest path to a hackable install is the bare-metal installer on a fresh Ubuntu 22.04 / 24.04 VM:

```bash
git clone https://github.com/purpledurpl075/Anthri-mon.git
cd Anthri-mon
sudo bash infra/scripts/install.sh
```

After that, the codebase layout is:

```
api/backend/          FastAPI + SQLAlchemy backend (Python 3.12)
collectors/snmp/      Hub-side SNMP poller (Go 1.22)
collectors/flow/      NetFlow/sFlow ingest (Go)
collectors/syslog/    Syslog ingest (Go)
collectors/remote/    Customer-premises collector (Go, all-in-one)
frontend/dashboard/   React 19 + Vite + TypeScript
storage/migrations/   Postgres + ClickHouse schema migrations
infra/                Installer + sudoers + systemd unit templates
scripts/              CLI helpers (anthrimon-backup, show-suppression, ...)
```

Run the dev API directly for fast iteration:
```bash
cd api && .venv/bin/python -m uvicorn backend.main:app --reload
```

Frontend dev server (proxies to the API on :8001):
```bash
cd frontend/dashboard && npm run dev
```

## DCO

We use the [Developer Certificate of Origin](https://developercertificate.org/), not a CLA. By signing off your commits, you assert that you have the right to contribute the code under the project's Apache 2.0 license.

To sign off: `git commit -s` (adds a `Signed-off-by: …` line). Configure once with `git config user.email`.

CI rejects PRs whose commits aren't signed off.

## Code style

**Python (backend):**
- PEP 8 with the relaxations in the existing code (long type hints OK, multi-line imports OK).
- Use `from __future__ import annotations` at the top of new files.
- Type-hint public function signatures.
- Errors use `structlog`'s logger, not `print`. `logger.error("event_name", field=value)`.
- No new dependencies without discussing first.

**Go (collectors):**
- `gofmt` it.
- Group related concerns into the existing `internal/` subpackages.
- Errors wrap (`fmt.Errorf("doing X: %w", err)`).
- New top-level packages need discussion.

**TypeScript (frontend):**
- The repo's existing Tailwind tokens — don't introduce new ones unless a designer is involved.
- `react-query` for data fetching; no `useEffect` for fetches.
- Pages live in `frontend/dashboard/src/pages/`; API clients in `src/api/`.

**Across all languages:**
- Avoid comments that explain *what* the code does — the code already does. Reserve comments for *why* (constraints, surprising invariants, workarounds for upstream bugs).
- Don't add backward-compat shims for code that hasn't shipped yet.

## Testing

- Backend: `cd api && .venv/bin/pytest` — add tests for new alert evaluators, parsers, and anything algorithmic.
- Collectors: `go test ./...` per package.
- Frontend: no test suite yet — that's a contribution we'd happily accept.
- Manual: real lab gear is the strongest validation. We keep a small mix of vIOS / vEOS / Aruba CX / ProCurve in the CI sandbox for protocol-level fixes.

## PR process

1. PR title in the form `topic: brief description` (e.g. `traps: classify VRRP backwardTransition`). No emoji.
2. PR body explains the *why* and any operator-visible behaviour change. Screenshots for UI changes.
3. One reviewer ack is enough for bug fixes. Two for new features or anything touching the alert engine.
4. Squash-merge by default. We keep a clean linear `main`.

## Reporting bugs / asking questions

- Public issues for bugs, feature requests, and how-to questions.
- Security issues — see [SECURITY.md](SECURITY.md). **Do not** open a public issue for a vulnerability.

## License

By contributing you agree your contributions are licensed under [Apache License 2.0](LICENSE).
