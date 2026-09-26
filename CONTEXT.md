# dilna

A self-hosted, web-based workspace for running AI coding agents against locally-cloned repositories. Agents run on the server and are driven through a web chat interface, so work continues even when the user's machine is offline.

## Language

**Repo**:
A git repository cloned onto the server. A repo can host many parallel **Sessions**, each working on a different branch via a worktree.
_Avoid_: project, codebase

**Worktree**:
A git worktree linked to one branch of a **Repo**, created from the Repo's default branch. A Worktree is the working directory for exactly one **Session**; the mapping is 1:1. New Worktree = new Session; existing Worktree = resume its Session. Multiple Sessions on one Worktree is out of MVP.
_Avoid_: checkout, working copy, clone (a clone makes a Repo, not a Worktree)

**Session**:
A resumable chat conversation with an AI agent, bound 1:1 to a single **Worktree**. A Session targets one feature or bugfix. Parallel work is done by opening parallel Sessions, each on its own Worktree. A Session has a **title** shown in the UI. The prior Claude-CLI-backed Agent auto-derived a title from the transcript after the first message; the current pi-agent-core-based Agent has no equivalent (no CLI, no transcript summary), so on the Session's first turn dilna asks the pi agent itself — a small, isolated bare-model call on the Session's own provider/model — for a short 3-4 word title derived from the user's first prompt (`agents/pi.ts`'s `generateSessionTitle`). The framework writes a generic placeholder at creation time, replaced by that derivation as soon as it lands; best-effort, so a failed derivation leaves the placeholder until a later turn retries it. The git branch underlying a Session is internal plumbing — the user never sees or names it; the user asks the agent to push to whatever remote branch they choose.
_Avoid_: conversation, thread, run

**Agent**:
The process that executes AI work for a **Session** against its **Worktree**, independent of which **Provider**/**Model** it talks to. An Agent is a pi-ai/pi-agent-core-based adapter (`apps/server/src/agents/pi.ts`), built on `pi-agent-core`'s bare `Agent` class; see ADR-0011 for why dilna standardizes on a single backend file (not a `handle.kind` union) and ADR-0020 for the decision to replace the prior Claude-Agent-SDK-backed Agent with this one.
_Avoid_: model, assistant, bot, backend (ambiguous between Agent and Provider — see Provider)

**Provider**:
The LLM vendor an Agent talks to — Anthropic, DeepSeek, Kimi (Moonshot), or Zhipu (GLM). Selected via a single global env var for the whole dilna instance, not a per-session choice; see ADR-0020. Distinct from the **Agent** itself: one Agent implementation is meant to serve any configured Provider, rather than one adapter per Provider.
_Avoid_: backend (see Agent)

**Model**:
The specific LLM a **Provider** serves — e.g. Claude Opus, DeepSeek-V3, Kimi K2, GLM-4.7. Selected alongside Provider via the same env var; see ADR-0020.
_Avoid_: using "model" for the **Agent** itself (see Agent's _Avoid_)

**Artefact**:
A file an **Agent** produced and explicitly *published* for the user to **open** — an HTML report, markdown document, PDF or image. An Artefact belongs to exactly one **Session** and is stored outside every **Worktree**; see ADR-0032 and ADR-0043. Distinct from an Agent-sent **Attachment**, which the user *sees inline in the conversation* rather than opens from a panel: an Agent that wants to show a picture sends an image, an Agent that wants to hand over a document publishes an Artefact. An Artefact is an immutable *copy* taken at publish time, not a pointer at a Worktree file: republishing a regenerated report mints a second Artefact so the two versions can be compared. A file the Agent merely wrote into its Worktree is not an Artefact until it publishes it.
_Avoid_: output, export, report (a report is one *kind* of Artefact), asset

**Comparison**:
A set of two or more **Sessions** on the same **Repo**, each pinned to a different **Model**, created together to run the same prompt so their outputs can be read side by side. A Comparison is a grouping over Sessions, not an entity of its own — it has no transcript, no Worktree, and no turn path of its own; each member **Session** (an "arm") is an ordinary Session in every other respect. Follow-up prompts are addressed to individual arms, not to the Comparison.
_Avoid_: experiment, benchmark, arena (blind/presentation concerns), race

**Queued Message**:
A message the user submitted to a **Session** while its **Agent** was still busy with a turn. Held durably on the server (ADR-0033) — not in any browser, so a locked phone or closed tab loses nothing — and drained automatically when the in-flight turn ends: the whole queue becomes *one* combined next turn, in submission order. Visible in the composer of every connected client and removable until drained; after that it is part of an ordinary message. Draining happens at every turn boundary regardless of how the turn ended (completed, failed, stopped).
_Avoid_: draft (a draft is unsubmitted composer text), scheduled message, pending message (ambiguous with a pending **Attachment** upload)

**Attachment**:
A file carried by a message in a **Session**, in either direction: one the user uploaded and sent, or an image the **Agent** sent into the chat (see ADR-0031 and ADR-0038). Its *source* says which. An Attachment belongs to exactly one Session and is stored outside every **Worktree**, so it is never part of a **Repo**'s git history unless the user asks the Agent to copy it in. An Attachment is either an *image* (one the Provider can see as pixels, and the only kind an Agent may send) or a *document* (one the Agent reads from disk). An Agent-sent Attachment is an immutable *copy* taken out of the Worktree, for the same reason an **Artefact** is.
_Avoid_: upload (an upload is only the user→Agent direction)
_Avoid_: upload, file (unqualified — "file" means a file in the Worktree), asset, media