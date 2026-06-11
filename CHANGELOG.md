# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The hub API and dashboard share a single platform version. The remote
collector is versioned independently (see `collectors/remote/cmd/remote-collector/main.go`).

## [Unreleased]

## [0.9.0] - 2026-06-11

### Security

- Closed a cross-tenant configuration vector where any tenant admin could
  edit a single global settings blob that controlled alerting and
  notification behavior for *every* tenant (notification pause, business-hours
  suppression, device-down thresholds, storm protection, alert retention,
  platform branding, and the WireGuard collector endpoint).

### Changed

- Split platform configuration into two tiers:
  - **Platform-wide settings** (`/platform/settings`, platform admin only):
    base URL, platform name, timezone, AbuseIPDB API key, WireGuard public
    endpoint, plus org-wide defaults for alerting/notification behavior.
  - **Per-tenant alerting overrides** (`/admin/settings/alerting`, tenant
    admin): device-down threshold, storm protection, auto-close, alert
    retention, notification pause, and business-hours scheduling, each
    falling back to the platform-wide default when not overridden.
- Removed three unused legacy settings (`alert_eval_interval_s`,
  `default_renotify_s`, duplicate `session_timeout_hours`).

### Added

- `CHANGELOG.md` and platform version tracking (hub API + dashboard now
  report `0.9.0`; the remote collector continues to version independently).

Changes prior to this point are not itemized in this changelog; see
`git log` for history.
