# Findings carry a server-declared action

## Context

ADR-0051 established the burn-findings seam: the server computes findings,
the web renders them and computes nothing. Finding K (#295, unused skills) is
the first finding that is directly actionable *in dilna* — dilna is the
config, so "disable the skill for this Repo" resolves the finding, and
leaving the resolution to the user's memory of where the Skills page lives
would waste the finding. Subsequent findings may have their own one-click
resolutions, so the affordance needs a shape, not a special case.

## Decision

`BurnFinding` gains an `action: BurnFindingAction | null` field, and the
*server* declares which action a finding supports — the web never derives an
affordance from the `check` code. The union's first member is
`{ kind: "disable-skill-for-repo", skillId, skillName }`; the web renders the
button, calls the existing enablement API (`POST /api/skills/:id/enabled`
with `enabled: false`), and re-reads the summary so the resolved finding
disappears. There is no new route: the action targets the API that already
owns the enablement state, so acting on a finding and flipping the toggle on
the Skills page cannot disagree.

Declaring the action server-side keeps the ADR-0051 single-home policy
intact: which resolution goes with which finding is domain knowledge (the
web would otherwise need a per-check mapping that drifts the moment a check
changes or a new one lands). Actions are advisory in the other direction
too — a finding without a verifiable $ figure still carries its action; the
finding is a diagnosis, the action a treatment, and neither gates the other.

## Consequences

- The web's per-check knowledge stays exactly the exhaustive
  `Record<BurnCheckCode, label>` map ADR-0051 introduced; actions ride the
  finding row and need no web-side registration.
- Acting on a finding is a normal authenticated API call, so the button can
  fail like any toggle (and shows that error inline); the finding only
  clears when the summary re-read confirms the underlying state changed —
  the UI never clears optimistically.
- Checks whose findings have no in-dilna resolution (e.g. overdepth) set
  `action: null`; the field is never a vague "see the docs" pointer.
