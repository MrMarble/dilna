# Sidebar Sessions list replaced by header dropdown + Background Agents panel

The sidebar previously listed a repo's Sessions directly, each with a status dot and delete action. We're removing that list: the chat header gets a dropdown to switch between the current repo's Sessions (labeled by title, never by the underlying branch — `CONTEXT.md`'s branch-is-internal-plumbing rule is unchanged), and the sidebar gains a "Background Agents" panel listing Sessions (any repo, excluding the focused one) that are `starting`/`working`/`stopping`/`crashed`.

We picked this over keeping the per-repo list because a persistent Sessions list can't show "is my other session still working" without either switching repos or duplicating status across every repo's list. Background Agents solves that directly, at the cost of losing an always-visible per-repo Session list — switching within a repo now requires opening the header dropdown instead of scanning the sidebar.

Background Agents is fed by the cross-session status SSE stream ADR-0006 already reserved (`routes/stream.ts`, "per Q17") — this ADR is what finally consumes that stub, not a new streaming mechanism. "Background Agents" is UI copy only; the underlying data is `Session`/`SessionView`, consistent with the existing glossary — "Agent" still means the process, not the unit of work shown in the panel.
