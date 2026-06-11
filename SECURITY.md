# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for a suspected vulnerability.**

Report security issues privately by opening a [GitHub security advisory](https://github.com/purpledurpl075/Anthri-mon/security/advisories/new). The advisory channel is visible only to project maintainers and the reporter, and supports private back-and-forth until disclosure is coordinated.

Include in the report:

- A clear description of the issue and what an attacker could do
- Affected version (output of `git rev-parse HEAD` if running from source)
- Steps to reproduce — proof-of-concept code is welcome
- Your name / handle if you want public credit in the advisory

## What to expect

| Step | Target |
|---|---|
| Acknowledgement that we received your report | within 3 business days |
| Initial triage + severity assessment | within 7 business days |
| Patched release for confirmed criticals | within 14 days of triage |
| Patched release for confirmed highs | within 30 days of triage |
| Public advisory + CVE filing | coordinated with you, usually after the patched release ships |

If the issue is critical and exploitation is straightforward, we may issue a hotfix on the next-numbered patch release and coordinate disclosure quickly.

## Supported versions

We support security fixes for the latest tagged release and the previous one. Older releases get fixes only at maintainer discretion, typically for critical issues.

| Version | Status |
|---|---|
| `main` | Active development, fixes land here first |
| Latest tagged release | Fully supported |
| Previous tagged release | Security fixes only |
| Older | Best effort |

## Scope

In scope:
- The Anthrimon API, collectors, frontend, and installer in this repository
- Anthrimon-generated configs deployed to monitored devices
- Default deployment posture (TLS, WireGuard, auth)

Out of scope:
- Third-party dependencies' own vulnerabilities — please report those upstream first; we'll patch our use of them as needed
- Issues in the operator's environment (misconfigured nginx, weak passwords, exposed `:8001`)
- Social engineering against project maintainers

## Hall of Fame

Reporters who follow this process and confirm a real issue get credited in the advisory and (with permission) in a `SECURITY-CREDITS.md` once we ship the fix.
