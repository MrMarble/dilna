# Env-var provider/model config contract

Design for wayfinder ticket [Design: env-var provider/model config contract](https://github.com/MrMarble/dilna/issues/98), child of map [#93](https://github.com/MrMarble/dilna/issues/93). Grounded by running the actual installed `@earendil-works/pi-ai` 0.84.3 package's exported functions directly (`node -e`, not reading `.d.ts` alone) against `/home/atm/Documents/repos/pi-sandbox-spike/node_modules/@earendil-works/pi-ai` — `getBuiltinProviders()`, `getBuiltinModels(provider)`, and `env-api-keys.js`'s `getApiKeyEnvVars()` table. This surfaced a factual error in [ADR-0020](https://github.com/MrMarble/dilna/blob/adr/0020-adopt-pi-stack/docs/adr/0020-adopt-pi-stack-for-agent-backend.md) (corrected on its branch as part of resolving this ticket, see §1) — reinforces why this ticket runs the catalog itself rather than trusting a provider name string quoted secondhand.

## 1. Correction to ADR-0020: Kimi K2 is `MOONSHOT_API_KEY`, not `KIMI_API_KEY`

ADR-0020 named DeepSeek/Kimi K2/GLM-4.7 as the v1 provider set, citing `DEEPSEEK_API_KEY`/`KIMI_API_KEY`/`ZAI_API_KEY` from `pi-coding-agent`'s `docs/providers.md`. Running the installed package's actual provider catalog:

```
$ node -e "console.log(require('./dist/providers/all.js').getBuiltinProviders())"
[ 'amazon-bedrock', 'ant-ling', 'anthropic', ..., 'deepseek', ..., 'kimi-coding', ...,
  'moonshotai', 'moonshotai-cn', ..., 'zai', 'zai-coding-cn', ... ]
```

`pi-ai`'s `env-api-keys.js` (`getApiKeyEnvVars()`) maps each provider id to its env var:

| Provider id | Env var | Sample model ids |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash`, `deepseek-v4-pro` |
| `kimi-coding` | `KIMI_API_KEY` | `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed` |
| `moonshotai` | `MOONSHOT_API_KEY` | `kimi-k2-0711-preview`, `kimi-k2-thinking`, `kimi-k2.7-code`, ... |
| `moonshotai-cn` | `MOONSHOT_API_KEY` | same catalog as `moonshotai` (CN region) |
| `zai` | `ZAI_API_KEY` | `glm-4.7`, `glm-5-turbo`, `glm-5.2`, `glm-5.3` |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | same catalog as `zai` (CN region) |
| `anthropic` | `ANTHROPIC_API_KEY` (also accepts `ANTHROPIC_AUTH_TOKEN`, but dilna configures only the API-key var per ADR-0020) | `claude-sonnet-5`, `claude-opus-5`, ... |

`kimi-coding` is a **different provider** — its catalog (`k3`, `kimi-for-coding`) has nothing named `kimi-k2-*`. ADR-0020's "Kimi K2" refers to the model family that only exists under `moonshotai`/`moonshotai-cn`. `KIMI_API_KEY` is real but is the wrong var for what ADR-0020 actually meant. Corrected on the ADR's branch (`adr/0020-adopt-pi-stack`) as part of resolving this ticket — worth having caught before PR #100 merges, not after.

**dilna's v1 provider id set, corrected**: `anthropic`, `deepseek`, `moonshotai`, `zai` — not `kimi-coding` or the `-cn` regional variants (no stated reason to prefer a CN-region endpoint; the plain ids are the sensible default, and nothing in map #93 asked for region selection).

## 2. Var names

Existing dilna env vars (`DILNA_DATA_DIR`, `DILNA_WEB_ORIGIN`, `DILNA_WEB_DIST`, `DILNA_CONTAINERIZED`, per `apps/server/src/{db/index.ts,index.ts,agents/claude.ts}`) follow `DILNA_<NOUN>` — short, one concept per var, read inline via `process.env.DILNA_X` at the point of use (no central config module).

Recommend **`DILNA_PROVIDER`** / **`DILNA_MODEL`**, not the ticket's suggested `DILNA_AGENT_PROVIDER`/`DILNA_AGENT_MODEL`. CONTEXT.md (via ADR-0020's own edit) just split **Agent** (the fixed adapter implementation — always `pi.ts`, not configurable) from **Provider**/**Model** (the configurable LLM vendor/model) specifically to stop conflating them under one word. Naming the env vars `DILNA_AGENT_PROVIDER`/`DILNA_AGENT_MODEL` re-blurs the exact distinction that split was for — `DILNA_PROVIDER`/`DILNA_MODEL` names the two configurable concepts directly and matches the terser existing `DILNA_<NOUN>` pattern.

## 3. Valid values: validate against pi-ai's live catalog, not a hand-maintained union

`BuiltinProvider = keyof typeof MODELS` (`pi-ai/dist/providers/all.d.ts`) is a **generated** catalog — it changes as `pi-ai` ships new versions (compare ADR-0019's `claude-sonnet-4-5` baseline against 0.84.3's `claude-sonnet-5` above; models are added/renamed/removed across releases dilna doesn't control the timing of). Hand-copying a fixed TypeScript union of provider/model ids into dilna's own source (e.g. a `Provider = "anthropic" | "deepseek" | ...` literal type) would drift stale the first time `pi-ai` bumps its catalog and dilna doesn't rebuild against the new version same-day. Validate dynamically instead, at server startup:

1. **Provider**: `DILNA_PROVIDER` must be one of dilna's own v1 allowlist — `["anthropic", "deepseek", "moonshotai", "zai"]`, a plain array literal in `pi.ts` (or a new small `apps/server/src/agents/providerConfig.ts`), not the full ~37-provider `getBuiltinProviders()` list. This is a **deliberate narrower allowlist**, not a completeness check against pi-ai's catalog: map #93/ADR-0020 named exactly these four as what's tested and supported for v1 (Out of scope explicitly excludes "custom/self-hosted... providers... not needed for the named providers this migration targets" — the same reasoning extends to pi-ai's other ~33 built-in providers, which are equally untested for dilna's purposes even though pi-ai itself supports them). An operator setting `DILNA_PROVIDER=openai` should get a clear "not a supported provider" error, not silent behavior nobody's verified.
2. **Model**: once the provider passes, validate `DILNA_MODEL` by checking it's a member of `getBuiltinModels(provider).map(m => m.id)` — this call already reads the live, current catalog, so there's nothing to hand-maintain here at all; a stale model id in dilna's own docs/examples would be caught by this check, not silently accepted.

## 4. Fail fast at server startup, not lazily on first turn

Validate all three of the following **before the server starts accepting requests** (`apps/server/src/index.ts`, alongside the existing `DILNA_WEB_ORIGIN`/`DILNA_WEB_DIST` reads — no new lifecycle phase needed, just more checks in the same place):

1. `DILNA_PROVIDER` is set and in the v1 allowlist (§3.1).
2. `DILNA_MODEL` is set and is a valid model id for that provider (§3.2).
3. The provider's required API-key env var (`pi-ai`'s `getEnvApiKey(provider)`, or equivalently `findEnvKeys`) actually resolves to a value — i.e. the operator has actually set `ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`/`MOONSHOT_API_KEY`/`ZAI_API_KEY` to match whichever provider they picked.

On any failure, refuse to start with a clear, specific error (name the exact missing/invalid var and, for an invalid provider, list the four valid ones) — not a generic crash. This is a strictly better failure mode than today's implicit behavior anyway: `claude.ts` currently passes no `env` override to `query()` (inherits `process.env` wholesale) and never validates `ANTHROPIC_API_KEY`/CLI auth exists before spawning — a misconfigured deployment currently discovers that only when a user sends the first message and the turn fails. Fail-fast at startup is a real improvement, not just parity, and it's cheap: every check above is a synchronous lookup against an already-loaded catalog, no network calls.

## 5. No default provider or model — both required

Considered defaulting `DILNA_PROVIDER` to `"anthropic"` (dilna's only provider historically) for zero-config upgrades, but **there is no existing default to preserve**: `claude.ts`'s `query()` call never passes a `model` option today — it relies entirely on `claude-agent-sdk`/the Claude Code CLI's own default model selection, which dilna's own source has never pinned to a specific id. There's nothing named "dilna's default model" today, so there's no precedent for `pi.ts` to preserve one, and `pi-ai`'s catalog exposes no "default model for this provider" field to defer to instead (`Model` has no `default`/`recommended` flag, per the fields listed in §1's table) — any default dilna picked would be dilna hardcoding a specific model id into its own source, with the same staleness risk §3 avoids for validation. Given map #93's "single global env-var pair, no picker UI" framing already treats this as one deliberate, explicit choice per deployment rather than an implicit one, requiring both vars with no default is the simpler, honester contract: an unconfigured deployment fails clearly at startup (§4) telling the operator exactly what to set, instead of silently running against a model choice nobody actually made.

## Summary for the execution session

- Add `DILNA_PROVIDER` / `DILNA_MODEL` (not `DILNA_AGENT_PROVIDER`/`DILNA_AGENT_MODEL`) to `apps/server/src/index.ts`'s startup sequence.
- Validate against a dilna-owned four-entry allowlist (`anthropic`, `deepseek`, `moonshotai`, `zai` — **not** `kimi-coding`, **not** the `-cn` variants) for provider, and against `pi-ai`'s live `getBuiltinModels(provider)` catalog for model — no hand-maintained model-id union in dilna's own types.
- Fail server startup with a specific error if either var is unset/invalid, or if the matching API-key env var (via `pi-ai`'s `getEnvApiKey`) isn't present — strictly better than today's "discover it on first turn" behavior.
- No defaults for either var — both required explicitly, since there's no pre-existing default model to preserve and no catalog-provided default to defer to.
- `docker-compose.yml` needs `DILNA_PROVIDER`/`DILNA_MODEL` and the three new provider API-key pass-throughs (`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`) added alongside the existing `ANTHROPIC_API_KEY` pass-through — noted for the execution session, not this ticket's job to edit.
