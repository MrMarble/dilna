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
A resumable chat conversation with an AI agent, bound 1:1 to a single **Worktree**. A Session targets one feature or bugfix. Parallel work is done by opening parallel Sessions, each on its own Worktree. A Session has a **title** shown in the UI; until the first message is sent the title is generic, afterwards it is taken from the agent's auto-derived title. The git branch underlying a Session is internal plumbing — the user never sees or names it; the user asks the agent to push to whatever remote branch they choose.
_Avoid_: conversation, thread, run

**Agent**:
The process that executes AI work for a **Session** against its **Worktree**. Today an Agent is the Claude Agent SDK (`apps/server/src/agents/claude.ts`); see ADR-0011 for why dilna standardized on a single backend.
_Avoid_: model, assistant, bot