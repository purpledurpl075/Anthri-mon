<!--
Thanks for the PR! Before opening, please check:

  1. There's an issue tracking this change (or you've discussed it with maintainers).
     Drive-by refactors and reformat-only PRs are usually closed.
  2. Each commit is signed off (`git commit -s`) — see CONTRIBUTING.md DCO section.
  3. The API loads, all collectors compile, and the frontend builds.

Replace the sections below — placeholder text won't merge.
-->

## What this changes

<!-- One or two sentences describing the user-visible behaviour change. -->

## Why

<!-- Link the issue, describe the operator pain, or cite the discussion that led here. -->

Fixes #

## How

<!-- Brief technical summary. Mention any data-model or migration changes. -->

## Operator-visible behaviour

<!-- For UI changes: screenshots. For API changes: the request/response shape. For new
     alert rules or evaluators: the trigger conditions. For migrations: whether it's
     forward-only or backwards-compatible. Delete this section if there's no
     operator-visible change. -->

## Risk

<!-- One line. Examples:
       - Low: read-only endpoint, behind admin auth.
       - Medium: changes alert engine state machine, all existing rules re-evaluate.
       - High: migration drops + recreates the alerts table.
     Be honest. Reviewers grade reviews against the stated risk. -->

## Tests

- [ ] API loads cleanly (`python -c "from backend.main import app"`)
- [ ] Affected Go collector builds (`go build ./...` in the relevant `collectors/*/` dir)
- [ ] Frontend builds (`npm run build`)
- [ ] Added/updated unit tests where the change has an algorithmic shape
- [ ] Tested against real lab gear OR explained why this can't reasonably be tested live

## Checklist

- [ ] Commits are signed off (`git commit -s`)
- [ ] No new dependencies added (or, if added, justified in the PR description)
- [ ] No new top-level config knobs added (or, if added, default behaviour is unchanged)
- [ ] Migrations (if any) are forward-only and the install order is correct
- [ ] CHANGELOG entry added under "Unreleased"
