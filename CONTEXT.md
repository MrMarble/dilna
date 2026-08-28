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
A resumable chat conversation with an AI agent, bound 1:1 to a single **Worktree**. A Session targets one feature or bugfix. Parallel work is done by opening parallel Sessions, each on its own Worktree. A Session has a **title** shown in the UI. The prior Claude-CLI-backed Agent auto-derived a title from the transcript after the first message; the current pi-agent-core-based Agent has no equivalent (no CLI, no transcript summary — see ADR-0020), so a Session's title stays generic indefinitely under it. The git branch underlying a Session is internal plumbing — the user never sees or names it; the user asks the agent to push to whatever remote branch they choose.
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