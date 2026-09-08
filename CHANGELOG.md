# Changelog

## [0.23.2](https://github.com/MrMarble/dilna/compare/v0.23.1...v0.23.2) (2026-09-08)


### Bug Fixes

* **server:** bundle @dilna/shared into the build instead of leaving it external ([#172](https://github.com/MrMarble/dilna/issues/172)) ([dfd65ab](https://github.com/MrMarble/dilna/commit/dfd65abb3aed0dc882b1ed967f21d920db870ccf))

## [0.23.1](https://github.com/MrMarble/dilna/compare/v0.23.0...v0.23.1) (2026-09-08)


### Bug Fixes

* **server+web:** base64url-encode skill ids to survive edge canonicalization ([#171](https://github.com/MrMarble/dilna/issues/171)) ([c339de7](https://github.com/MrMarble/dilna/commit/c339de7d032bc9459bf88e2b39d02a2aa5e2a1a2))
* **server:** pnpm still copied after [#159](https://github.com/MrMarble/dilna/issues/159) — wrong env var, then a false-negative auto-detect ([#169](https://github.com/MrMarble/dilna/issues/169)) ([7d064ff](https://github.com/MrMarble/dilna/commit/7d064ff7e250c66ab7f100f045814dbf8095b4ea))

## [0.23.0](https://github.com/MrMarble/dilna/compare/v0.22.0...v0.23.0) (2026-09-08)


### Features

* **server:** adopt pino structured logging ([#167](https://github.com/MrMarble/dilna/issues/167)) ([8a24d67](https://github.com/MrMarble/dilna/commit/8a24d67916a8d57263d315ea3a71fac63afd050c))


### Bug Fixes

* **server:** stop skill enable/uninstall 404ing behind other routes ([#166](https://github.com/MrMarble/dilna/issues/166)) ([5880ead](https://github.com/MrMarble/dilna/commit/5880eade9ee799f85708266b76d5ba1fced7de37))

## [0.22.0](https://github.com/MrMarble/dilna/compare/v0.21.0...v0.22.0) (2026-09-08)


### Features

* **skills:** manual skill install with global store and per-repo enablement ([#165](https://github.com/MrMarble/dilna/issues/165)) ([3c5d082](https://github.com/MrMarble/dilna/commit/3c5d0827e1cee41e0ec18b493851799a7ffc2b52))
* **web:** add copy buttons for messages and code blocks ([#163](https://github.com/MrMarble/dilna/issues/163)) ([3f14db5](https://github.com/MrMarble/dilna/commit/3f14db51b8ccc4c6ba375e1efac4697a16d5e420))


### Bug Fixes

* list pnpm before node in mise.toml to stop corepack shim shadowing ([#164](https://github.com/MrMarble/dilna/issues/164)) ([bf39950](https://github.com/MrMarble/dilna/commit/bf399503ca98c98fb7800e1cc184cdcd5d357b5a))
* **web:** drop cache tokens from the Metrics composition bar ([#161](https://github.com/MrMarble/dilna/issues/161)) ([b23a7b2](https://github.com/MrMarble/dilna/commit/b23a7b2506d6bbf41891ae7ae23a9ad44e1ca924))

## [0.21.0](https://github.com/MrMarble/dilna/compare/v0.20.0...v0.21.0) (2026-09-08)


### Features

* **web:** cost/token, token composition chart, top sessions on Metrics ([#160](https://github.com/MrMarble/dilna/issues/160)) ([bc0730f](https://github.com/MrMarble/dilna/commit/bc0730f85c66c833109de16c3ea14262ee0d3ab9))
* **web:** pending-state feedback for repo fetch and session delete ([#156](https://github.com/MrMarble/dilna/issues/156)) ([2e40430](https://github.com/MrMarble/dilna/commit/2e404303c1c8fcae98c96919bcb3d244843c1be7))


### Bug Fixes

* **server:** let pnpm hardlink its store inside the sandboxed bash tool ([#159](https://github.com/MrMarble/dilna/issues/159)) ([0ba3ca6](https://github.com/MrMarble/dilna/commit/0ba3ca680ec52ccaabc0e9f6824d4a458358bd8c))
* **web:** make the orchestrator chat, Metrics and Settings real routes ([#157](https://github.com/MrMarble/dilna/issues/157)) ([28ef90f](https://github.com/MrMarble/dilna/commit/28ef90fd7ca369099423b55b8260ca69f8a283f0))

## [0.20.0](https://github.com/MrMarble/dilna/compare/v0.19.0...v0.20.0) (2026-09-07)


### Features

* **web:** mobile UI polish — perf, tap feedback, safe-area, discoverability ([#152](https://github.com/MrMarble/dilna/issues/152)) ([5ed54e0](https://github.com/MrMarble/dilna/commit/5ed54e0a05f757e24d801eda164dc84ea964ce36))
* **web:** stack daily-cost chart by model ([#155](https://github.com/MrMarble/dilna/issues/155)) ([9ed99ea](https://github.com/MrMarble/dilna/commit/9ed99ea31dc1c8b3e32d17485d39e53b7700f692))

## [0.19.0](https://github.com/MrMarble/dilna/compare/v0.18.0...v0.19.0) (2026-09-07)


### Features

* **security:** opt-in Host allowlist + bearer auth, docker hardening ([#146](https://github.com/MrMarble/dilna/issues/146)) ([6755c89](https://github.com/MrMarble/dilna/commit/6755c8914a0fed244040ceef77fd82d851c49240))
* **server:** add web fetch tool ported from oh-my-pi's fetch pipeline ([#142](https://github.com/MrMarble/dilna/issues/142)) ([5e9dc4d](https://github.com/MrMarble/dilna/commit/5e9dc4dbc814fec06186d65a3e24fb3a754f0255)), closes [#138](https://github.com/MrMarble/dilna/issues/138)


### Bug Fixes

* biome.json glob bug and dead getRecentCommits limit param ([#147](https://github.com/MrMarble/dilna/issues/147)) ([56a477a](https://github.com/MrMarble/dilna/commit/56a477a7e69342eebe360247cb55e49997424f43))
* **server:** route validation, transactional writes, repo-delete cascade ([#148](https://github.com/MrMarble/dilna/issues/148)) ([11153bc](https://github.com/MrMarble/dilna/commit/11153bc75e913586a313933b0c04c415fec8aba7))
* **sessions:** harden turn durability against process interruption ([#144](https://github.com/MrMarble/dilna/issues/144)) ([b0393dd](https://github.com/MrMarble/dilna/commit/b0393dd6ebda0352b4925163d62aea58c353846a))

## [0.18.0](https://github.com/MrMarble/dilna/compare/v0.17.0...v0.18.0) (2026-09-06)


### Features

* **server+web:** add Anthropic OAuth login alongside API keys ([#140](https://github.com/MrMarble/dilna/issues/140)) ([f44128e](https://github.com/MrMarble/dilna/commit/f44128e6faff85efaa79ed30c4afd90ca60b221e))
* **server+web:** configure multiple LLM providers at once ([#136](https://github.com/MrMarble/dilna/issues/136)) ([c1a772b](https://github.com/MrMarble/dilna/commit/c1a772bb4d5fafc6dc42f709af5f226f80d83d64))
* **server+web:** support custom LLM providers (Ollama, LM Studio, vLLM, ...) ([#141](https://github.com/MrMarble/dilna/issues/141)) ([261f955](https://github.com/MrMarble/dilna/commit/261f9557552bbc42dd66a92da92cd79910186019))

## [0.17.0](https://github.com/MrMarble/dilna/compare/v0.16.0...v0.17.0) (2026-09-04)


### Features

* **agents:** make repo memory reads a tool call, not a system-prompt injection ([#131](https://github.com/MrMarble/dilna/issues/131)) ([01223f9](https://github.com/MrMarble/dilna/commit/01223f963dd47acc0bc3377cf0521a9bffa756ae))
* **server+web:** surface data-dir disk capacity on the Metrics view ([#132](https://github.com/MrMarble/dilna/issues/132)) ([07df6da](https://github.com/MrMarble/dilna/commit/07df6daaa0da941ff362346af788b6f13a65faa1))
* **server:** archive a deleted session's summary, orchestrator-readable (ADR-0024) ([#134](https://github.com/MrMarble/dilna/issues/134)) ([d979bfb](https://github.com/MrMarble/dilna/commit/d979bfb152dde52ce9f927021367c34a0731bb3f))
* **server:** budget-triggered session compaction (ADR-0023) ([#133](https://github.com/MrMarble/dilna/issues/133)) ([6ce972b](https://github.com/MrMarble/dilna/commit/6ce972b0a483115c497c0b5212d3347dc159a4fe))
* **server:** track which sessions an orchestrator spawned (ADR-0025) ([#135](https://github.com/MrMarble/dilna/issues/135)) ([1350831](https://github.com/MrMarble/dilna/commit/1350831e0f767a1e2390b562a61daa05cf0102bf))


### Bug Fixes

* **agents:** put mise's real shims dir on sandboxed bash PATH ([#128](https://github.com/MrMarble/dilna/issues/128)) ([2a06ded](https://github.com/MrMarble/dilna/commit/2a06ded32a6a91eb1bffc8f013f8817e5fe1000a))
* **agents:** root pi-coding-agent's rg/fd self-download dir under DILNA_DATA_DIR ([#130](https://github.com/MrMarble/dilna/issues/130)) ([3c8a85a](https://github.com/MrMarble/dilna/commit/3c8a85aea1763439c77c5075233e7ce58bb62cd9))

## [0.16.0](https://github.com/MrMarble/dilna/compare/v0.15.0...v0.16.0) (2026-09-03)


### Features

* **usage:** attribute usage to the model a session actually ran on ([#127](https://github.com/MrMarble/dilna/issues/127)) ([b473e29](https://github.com/MrMarble/dilna/commit/b473e29ce6925a0c303fb0670f982274b8affec0))


### Bug Fixes

* **sessions:** promote the pending user message when a cold-spawn turn is stopped ([#125](https://github.com/MrMarble/dilna/issues/125)) ([578526c](https://github.com/MrMarble/dilna/commit/578526cbe81bd4e6fb489825b3014f01f79c1ae6))

## [0.15.0](https://github.com/MrMarble/dilna/compare/v0.14.0...v0.15.0) (2026-09-03)


### Features

* **server+web:** configure LLM provider/model via a web Settings form ([#123](https://github.com/MrMarble/dilna/issues/123)) ([8964e08](https://github.com/MrMarble/dilna/commit/8964e085f09866ef908317ce608fa720d885672d))
* **web:** syntax-highlight chat code blocks with prism-react-renderer (issue [#55](https://github.com/MrMarble/dilna/issues/55)) ([#120](https://github.com/MrMarble/dilna/issues/120)) ([77d1a1a](https://github.com/MrMarble/dilna/commit/77d1a1abe3a3e8d7efb23799045622c80369319c))


### Bug Fixes

* **docker:** give runtime sessions a native compile toolchain ([#122](https://github.com/MrMarble/dilna/issues/122)) ([f633546](https://github.com/MrMarble/dilna/commit/f633546dccee987dcee7fd0d0db96e8885c768da))
* **server:** format drizzle 0008 snapshot to satisfy lint ([#124](https://github.com/MrMarble/dilna/issues/124)) ([8f94ede](https://github.com/MrMarble/dilna/commit/8f94ede54f2fa8f6fc0d22bc91a86147494f5e67))

## [0.14.0](https://github.com/MrMarble/dilna/compare/v0.13.1...v0.14.0) (2026-08-29)


### Features

* **agents:** index each Worktree with codegraph for pi Sessions ([#119](https://github.com/MrMarble/dilna/issues/119)) ([1451687](https://github.com/MrMarble/dilna/commit/14516878d38fa164e6659e735980c3d0394749f1))
* **web:** notify on turn completion (issue [#52](https://github.com/MrMarble/dilna/issues/52)) ([#112](https://github.com/MrMarble/dilna/issues/112)) ([23f4071](https://github.com/MrMarble/dilna/commit/23f4071decd9355f3a52ff95aa604b8bc5eaf5af))


### Bug Fixes

* **agents:** curb pi's overstepping and trim its system prompt ([#117](https://github.com/MrMarble/dilna/issues/117)) ([600664b](https://github.com/MrMarble/dilna/commit/600664b8918c91ddd7fa7380555c429382e03795))
* **sessions:** derive a short title from the first prompt for pi Sessions ([#111](https://github.com/MrMarble/dilna/issues/111)) ([9622d0e](https://github.com/MrMarble/dilna/commit/9622d0e404877b616a2c940f5b0abe6c22e6f848))

## [0.13.1](https://github.com/MrMarble/dilna/compare/v0.13.0...v0.13.1) (2026-08-28)


### Bug Fixes

* **agents:** add working-style guidance to pi's system prompt ([#115](https://github.com/MrMarble/dilna/issues/115)) ([2f8b8e6](https://github.com/MrMarble/dilna/commit/2f8b8e65bf0a771a968ae9501c025b56ab7e9545))
* **agents:** pre-create sandbox's default write paths so pnpm/mise work ([#113](https://github.com/MrMarble/dilna/issues/113)) ([775ccdf](https://github.com/MrMarble/dilna/commit/775ccdf4af2abc2d64406d85d32aa773982aea3e))

## [0.13.0](https://github.com/MrMarble/dilna/compare/v0.12.0...v0.13.0) (2026-08-28)


### Features

* **sessions:** add orchestrator sessions ([#109](https://github.com/MrMarble/dilna/issues/109)) ([9b5959b](https://github.com/MrMarble/dilna/commit/9b5959b0d1ccce218e47d94700bdb6c1e73037d4))

## [0.12.0](https://github.com/MrMarble/dilna/compare/v0.11.0...v0.12.0) (2026-08-28)


### Features

* **sessions:** export full transcript as a shareable link ([#107](https://github.com/MrMarble/dilna/issues/107)) ([af4a2c1](https://github.com/MrMarble/dilna/commit/af4a2c17d82c74d448252da6ccf88f1ee8d43a27))

## [0.11.0](https://github.com/MrMarble/dilna/compare/v0.10.0...v0.11.0) (2026-08-28)


### Features

* **agents:** replace claude-agent-sdk with pi-ai/pi-agent-core adapter ([#104](https://github.com/MrMarble/dilna/issues/104)) ([4167a92](https://github.com/MrMarble/dilna/commit/4167a9226f1b0f1a195d7b75daec4475d554a0cc))
* **dev:** load local API tokens from .env via mise ([#105](https://github.com/MrMarble/dilna/issues/105)) ([265b553](https://github.com/MrMarble/dilna/commit/265b55305a929ef2e0d0d5bf88f7fff16e9cf688))
* **usage:** add cost/token dashboard sourced from per-turn usage_events ([#106](https://github.com/MrMarble/dilna/issues/106)) ([4833d1a](https://github.com/MrMarble/dilna/commit/4833d1a178b6f570a88d7261a7945582a3db6cae))


### Bug Fixes

* **agents:** task-notification history rows, flat turn timeout, XDG sandbox grants ([#88](https://github.com/MrMarble/dilna/issues/88)) ([e844774](https://github.com/MrMarble/dilna/commit/e844774e3fb03ebfe8bae7950413a27f2dc68a38))

## [0.10.0](https://github.com/MrMarble/dilna/compare/v0.9.0...v0.10.0) (2026-08-21)


### Features

* **repos:** show ahead/behind vs origin in sidebar ([#80](https://github.com/MrMarble/dilna/issues/80)) ([dc2b8ea](https://github.com/MrMarble/dilna/commit/dc2b8ea172b92fcd020e308f7eb7fe094ecf0d04))
* **web:** overhaul mobile/desktop UX — collapsible panels, session tree, touch targets ([#85](https://github.com/MrMarble/dilna/issues/85)) ([eb63af6](https://github.com/MrMarble/dilna/commit/eb63af6dfcf55c55b33d2515133d7915037708ea))


### Bug Fixes

* **agents:** actually close the dangerouslyDisableSandbox escape hatch ([#74](https://github.com/MrMarble/dilna/issues/74)) ([#82](https://github.com/MrMarble/dilna/issues/82)) ([428b478](https://github.com/MrMarble/dilna/commit/428b4788bd890c50f9318f45a18983936c3aa090))
* **agents:** root mise/pnpm/gh toolchain state under DILNA_DATA_DIR, not $HOME ([#83](https://github.com/MrMarble/dilna/issues/83)) ([#86](https://github.com/MrMarble/dilna/issues/86)) ([107e749](https://github.com/MrMarble/dilna/commit/107e749a5a0325f1eeb78d9cecd65fdee3fa3d0f))
* **agents:** stop background task-notification from mis-rendering as a user message ([#84](https://github.com/MrMarble/dilna/issues/84)) ([50287b6](https://github.com/MrMarble/dilna/commit/50287b687c0c633bad8ff2367050f22bedbc172c))

## [0.9.0](https://github.com/MrMarble/dilna/compare/v0.8.0...v0.9.0) (2026-08-19)


### Features

* **repos:** add per-repo agent memory ([#75](https://github.com/MrMarble/dilna/issues/75)) ([6e4daa4](https://github.com/MrMarble/dilna/commit/6e4daa4d60ce555089d6049ae9caebf2a99fe53f))


### Bug Fixes

* **agents:** close the dangerouslyDisableSandbox escape hatch ([#74](https://github.com/MrMarble/dilna/issues/74)) ([#76](https://github.com/MrMarble/dilna/issues/76)) ([15f615b](https://github.com/MrMarble/dilna/commit/15f615b031e22507a0dd5a03ba9bbb1a5e63fdda))

## [0.8.0](https://github.com/MrMarble/dilna/compare/v0.7.0...v0.8.0) (2026-08-19)


### Features

* reflect selected repo/session in the URL path ([#68](https://github.com/MrMarble/dilna/issues/68)) ([94e3a71](https://github.com/MrMarble/dilna/commit/94e3a7176b172b4b3a05fcbee278e3a33e0e5b78))


### Bug Fixes

* **agents:** close remaining pnpm sandbox/toolchain gaps ([#70](https://github.com/MrMarble/dilna/issues/70)) ([#73](https://github.com/MrMarble/dilna/issues/73)) ([ac9e552](https://github.com/MrMarble/dilna/commit/ac9e552f7ccd4b5e8091067f91c95696950bd521))
* **sessions:** defer idle-kill while the agent has pending background work ([#71](https://github.com/MrMarble/dilna/issues/71)) ([a96238a](https://github.com/MrMarble/dilna/commit/a96238a79df16d4d6912621053a1c4a0fc1edb94))
* **sessions:** singleflight agent starts to prevent duplicate message id inserts ([#72](https://github.com/MrMarble/dilna/issues/72)) ([d77e21b](https://github.com/MrMarble/dilna/commit/d77e21b050cb018ec6a58b0296e5b07e6caa69be))

## [0.7.0](https://github.com/MrMarble/dilna/compare/v0.6.0...v0.7.0) (2026-08-13)


### Features

* **agents:** add ClaudeAgent adapter backed by @anthropic-ai/claude-agent-sdk ([1e6763d](https://github.com/MrMarble/dilna/commit/1e6763d41a27413ce35628a2eb692f88c73a8872))
* **agents:** give Claude sessions dilna-specific context via systemPrompt ([#22](https://github.com/MrMarble/dilna/issues/22)) ([18948d6](https://github.com/MrMarble/dilna/commit/18948d625c9ebab324ca7e000c6845ed46538f3e))
* **agents:** give sessions a self-serve toolchain via mise ([#16](https://github.com/MrMarble/dilna/issues/16)) ([65c4c0b](https://github.com/MrMarble/dilna/commit/65c4c0b7031f1c4af84201d3bf3436fd320f1491))
* **chat:** implement the agent-chat event-protocol contract (ADR-0016) ([#43](https://github.com/MrMarble/dilna/issues/43)) ([461b399](https://github.com/MrMarble/dilna/commit/461b39957ca470abdcb8891aaf7d96fa58e4d35e))
* **chat:** opencode serve integration with SSE-streamed chat UI ([f0f097e](https://github.com/MrMarble/dilna/commit/f0f097e5848ec472a36f0c291f46f34cb80def9b))
* **chat:** render assistant replies as markdown ([6e982f1](https://github.com/MrMarble/dilna/commit/6e982f14ad54fc944676b13b69b9ab6ddf363755))
* **deploy:** add single-container Docker image ([6387315](https://github.com/MrMarble/dilna/commit/63873158502c197275397a29a5a085faef227976))
* **docker:** add GitHub CLI (gh) with GH_TOKEN host-passthrough auth ([#24](https://github.com/MrMarble/dilna/issues/24)) ([d8a8cbc](https://github.com/MrMarble/dilna/commit/d8a8cbc5ce6a47ce08b23c0775002ee006d6eef6))
* **docker:** derive git commit identity from authenticated gh account ([#25](https://github.com/MrMarble/dilna/issues/25)) ([71cec50](https://github.com/MrMarble/dilna/commit/71cec5060e259c9818a189cdd5b2614726a950be))
* **repo:** implement repo cloning + sidebar with repo list and new-repo dialog ([f7f6fd8](https://github.com/MrMarble/dilna/commit/f7f6fd8023199e9989f68d5ffb52ec86a9dbbb17))
* **repos:** pull default branch from origin on sidebar refresh ([65f86ef](https://github.com/MrMarble/dilna/commit/65f86efe51e7e809ee87d88a123b2cd2638e923a))
* scaffold monorepo, glossary, ADRs, and stubbed services ([df79de9](https://github.com/MrMarble/dilna/commit/df79de9bf609ab4a7d628bd24b58a9dc3b214d0f))
* **session:** worktree-backed sessions with sidebar sessions list and CRUD ([27071d7](https://github.com/MrMarble/dilna/commit/27071d73c9424238f7a43d935174e10a3139bdf8))
* **sidebar:** add account-wide plan rate-limit footer ([bffdc9b](https://github.com/MrMarble/dilna/commit/bffdc9ba1814a028e27eb3dc3071e7fca82946f0))
* small improvements and usage progress bar ([15ef761](https://github.com/MrMarble/dilna/commit/15ef761035353f77d5a5c9360c809ef7ba36fbef))
* **web:** add agent selector to new-session creation ([fb8cfc3](https://github.com/MrMarble/dilna/commit/fb8cfc3cd0e35b46019b83e72eb9595cb6040ec7))
* **web:** add changed-files panel ([be16371](https://github.com/MrMarble/dilna/commit/be1637161dcf9c0eee83f9f5b77c81eca11b048b))
* **web:** add dark mode toggle to sidebar ([920cb27](https://github.com/MrMarble/dilna/commit/920cb271865e5ea24d50d3ae05ea7cb8a5b40111))
* **web:** add per-session token usage badge ([c6734a5](https://github.com/MrMarble/dilna/commit/c6734a55d42b68183843c8c763697406262e04f1)), closes [#10](https://github.com/MrMarble/dilna/issues/10)
* **web:** create sessions directly instead of via confirmation dialog ([2733ba2](https://github.com/MrMarble/dilna/commit/2733ba2b38d39a583c35d14e875177efe0762c06))
* **web:** mobile responsive layout for sidebar and changed-files panel ([f4816bf](https://github.com/MrMarble/dilna/commit/f4816bf552951530b60f159978ef7527e81db3c2)), closes [#12](https://github.com/MrMarble/dilna/issues/12)
* **web:** redesign sidebar and chat window per UI draft ([2f61c28](https://github.com/MrMarble/dilna/commit/2f61c28cacdd4c990a9bfdda33cc7bf0e4e5b5cf))
* **web:** show app version and commit info next to the dilna header ([ee5dbd1](https://github.com/MrMarble/dilna/commit/ee5dbd182494adfed2d9ec2002b5a6750cb3489c))


### Bug Fixes

* **agents:** distinguish a silent no-data usage pull from a thrown error ([#26](https://github.com/MrMarble/dilna/issues/26)) ([744f56c](https://github.com/MrMarble/dilna/commit/744f56c6612e9df7c8f46104a8a52946aa477b10))
* **agents:** grant worktree's shared git dir write access in sandbox ([#15](https://github.com/MrMarble/dilna/issues/15)) ([01b4aee](https://github.com/MrMarble/dilna/commit/01b4aee5ae0d2eac00143f606c8156c8039dae60))
* **agents:** log per-window shape from the OAuth usage endpoint pull ([#44](https://github.com/MrMarble/dilna/issues/44)) ([03c64fc](https://github.com/MrMarble/dilna/commit/03c64fc016378626866d3edbf7de409f8ab20d14))
* **agents:** log rate-limit usage pull failures instead of swallowing them silently ([#23](https://github.com/MrMarble/dilna/issues/23)) ([93f0469](https://github.com/MrMarble/dilna/commit/93f04698f1c8d0ab8f5a8972ab641b42d6e84995))
* **agents:** merge Claude's per-tool-round messages into one turn ([ab9928a](https://github.com/MrMarble/dilna/commit/ab9928a3edf0027326652a367fc2870adbc4e611))
* **agents:** migrate sandboxing from bubblewrap to sandlock ([9bbc82b](https://github.com/MrMarble/dilna/commit/9bbc82b5bdf8de63298cb8d0feb695ffdde3d0c1))
* **agents:** pre-trust the worktree so mise shims don't break on an untrusted mise.toml ([#20](https://github.com/MrMarble/dilna/issues/20)) ([c9c300b](https://github.com/MrMarble/dilna/commit/c9c300b7156c634a1023f660a2319b49a06dd781))
* **agents:** replace sandlock with Claude Code's built-in sandbox ([897b1ba](https://github.com/MrMarble/dilna/commit/897b1bacce611f02a30be59018489fcca3c41c94))
* **agents:** revert broken sandlock read confinement, improve crash logging ([d8e788e](https://github.com/MrMarble/dilna/commit/d8e788e132f0ac7297d123895cf447b5e72941fe))
* **agents:** sandbox agent processes to their worktree via bubblewrap ([7fcfef1](https://github.com/MrMarble/dilna/commit/7fcfef1a9dd8fe8a42af6e78172fea77973fe308))
* **agents:** stop ClaudeAgent from deadlocking on session start ([fc8f02e](https://github.com/MrMarble/dilna/commit/fc8f02e542bd7e0610a7742994d0f683de97e4bd))
* **chat:** coerce opencode error payloads to strings, flush live messages on idle/crash ([fa691f8](https://github.com/MrMarble/dilna/commit/fa691f80e23a9dea3dee234461bf124c318f165a))
* **chat:** eliminate flicker between live and persisted message states ([acc5d2b](https://github.com/MrMarble/dilna/commit/acc5d2b4cb27eba098f622a14c37e64d80ea08fa))
* **chat:** eliminate message flicker with optimistic placeholders and group tool calls ([18cf351](https://github.com/MrMarble/dilna/commit/18cf351fa0f069d7b1e8d3f1b1b52754a7668d8d))
* **chat:** message ordering, follow-the-stream autoscroll, fade clearance ([2820f17](https://github.com/MrMarble/dilna/commit/2820f17f52213e5015f48ef793a768efe4d205dd))
* **chat:** show tool call input/output when a tool group is expanded ([d60906c](https://github.com/MrMarble/dilna/commit/d60906c070c6e5009877674403e866f4d0c354fb))
* **docker:** make mise install failures fail the build, not surface as COPY errors ([fd43aba](https://github.com/MrMarble/dilna/commit/fd43aba0ce26265feeaec891e4649ac2af5fabfb))
* **docker:** run container as non-root, fix sandbox seccomp, bake real version/commit ([8631718](https://github.com/MrMarble/dilna/commit/863171865c7bfe784822c259c931dcb2763b2383))
* **repos:** give bare clones a normal-clone git contract for session worktrees ([#28](https://github.com/MrMarble/dilna/issues/28)) ([c199d45](https://github.com/MrMarble/dilna/commit/c199d45acdaff6dc78c6560dd0a5a307996bf154))
* restore release-please single-lineage tag config ([#66](https://github.com/MrMarble/dilna/issues/66)) ([d651bb5](https://github.com/MrMarble/dilna/commit/d651bb511c28f846b07031247c2e69f7e77dc0d3))
* **server:** persist Claude session storage, recover unresumable sessions ([0c43b17](https://github.com/MrMarble/dilna/commit/0c43b17e7b2a7c57eb9dff7e26173e8c80d5673e))
* **server:** stop sessions from wedging permanently on a stalled turn ([87c861a](https://github.com/MrMarble/dilna/commit/87c861ab46b543c5c03999e6f89de3f70b0f4c94))
* **sessions:** give new sessions a distinguishable default title ([4627b59](https://github.com/MrMarble/dilna/commit/4627b597eb96e6779306e8c345c1acd5173b8d77))
* **sessions:** log raw utilization from push rate_limit_events ([#46](https://github.com/MrMarble/dilna/issues/46)) ([fb194a9](https://github.com/MrMarble/dilna/commit/fb194a93d62df4a39af2829d7cdf04800dc15172))
* **sessions:** make chat history survive interruptions and replay in-flight turns (ADR-0014) ([#27](https://github.com/MrMarble/dilna/issues/27)) ([b3e9f47](https://github.com/MrMarble/dilna/commit/b3e9f479c28e9b4e3924005a8419a0ccafd75517))
* **sessions:** persist per-session token totals so the badge survives reloads ([5fd357c](https://github.com/MrMarble/dilna/commit/5fd357c48407b0b81880003b515f24a1452f50fe))
* **sessions:** persist user message immediately instead of at turn end ([2f40eac](https://github.com/MrMarble/dilna/commit/2f40eaca89ed2531c1513e0d2e531d3100c67108))
* **sessions:** source the usage bar from the claude.ai OAuth usage endpoint (ADR-0015) ([#29](https://github.com/MrMarble/dilna/issues/29)) ([3f1deb1](https://github.com/MrMarble/dilna/commit/3f1deb104bb6852f5ffb6c4055ea009dea79a084))
* **sidebar:** source plan rate limits from the SDK usage pull and persist them ([39c2424](https://github.com/MrMarble/dilna/commit/39c242429fb6b035c23176d820e85e7228f66bb9))
* **sidebar:** stop dropping real rate-limit data for OAuth accounts ([c416c7b](https://github.com/MrMarble/dilna/commit/c416c7ba93e68a15d05a07c18ec58d3e934aa0bf))
* **web:** declutter mobile chat header by relocating delete/tokens into sheets ([7675dbd](https://github.com/MrMarble/dilna/commit/7675dbdbff2033d0459d39ae9d58a29d2d2f56b3))
* **web:** fix mobile viewport height, add PWA manifest ([7aeab01](https://github.com/MrMarble/dilna/commit/7aeab016597b6e7f8d7ec687749fa2cac9be4cfc))
* **web:** interleave tool calls and text in live message stream ([57d3662](https://github.com/MrMarble/dilna/commit/57d36626b956b0f32730e48a6b3a247e60724ea9))
* **web:** invert mobile Enter-key behavior to insert newline instead of sending ([#14](https://github.com/MrMarble/dilna/issues/14)) ([80e4ac6](https://github.com/MrMarble/dilna/commit/80e4ac6a576593a6c8445d942d73eaa4dceb29d3))
* **web:** invert mobile Enter-key behavior to insert newline instead of sending ([#17](https://github.com/MrMarble/dilna/issues/17)) ([2ec8d82](https://github.com/MrMarble/dilna/commit/2ec8d820af4ef9f8bbf49d18de487eba1e10883d))


### Dependencies

* add project verify skill with isolated-instance recipe ([369ae75](https://github.com/MrMarble/dilna/commit/369ae75d81fdf0f733d50c8e2c9b6c9e59f5e04e))
* add release-please manifest config for bot dependency releases ([#62](https://github.com/MrMarble/dilna/issues/62)) ([5ccbf8a](https://github.com/MrMarble/dilna/commit/5ccbf8a065ef703a834393c4fa296218edd7458e))
* bump 0.2.1 version ([541e62d](https://github.com/MrMarble/dilna/commit/541e62ddff082652b10a918243290bbf2391866a))
* bump versión 0.2.0 ([54817ef](https://github.com/MrMarble/dilna/commit/54817efe3bfeda2ad6923c00078e1bb31120394c))
* Bump version from 0.4.0 to 0.4.1 ([d1e59f2](https://github.com/MrMarble/dilna/commit/d1e59f2842b7f29ebeacb0a8d24d5f741cdd773d))
* bump version to 0.1.1 ([e56600a](https://github.com/MrMarble/dilna/commit/e56600a175e640cad8f195688087c99311feb587))
* bump version to 0.1.2 ([cd12463](https://github.com/MrMarble/dilna/commit/cd124636230fb635aca2fd75e4a72d22e570a9db))
* bump version to 0.1.3 ([f667cd9](https://github.com/MrMarble/dilna/commit/f667cd99cded1a9bf5976cecdba0739ea7fe6aad))
* bump version to 0.3.0 ([464113b](https://github.com/MrMarble/dilna/commit/464113b72e5975bc3177adac5948d2aed54e4da6))
* bump version to 0.4.0 ([0bfd8ce](https://github.com/MrMarble/dilna/commit/0bfd8ceb002628b982edbd6a22683d73f3415a56))
* **deps:** bump @hono/node-server from 1.19.14 to 2.1.0 ([#58](https://github.com/MrMarble/dilna/issues/58)) ([3625e81](https://github.com/MrMarble/dilna/commit/3625e8106f04f8ca52e20a8b971d268289dff24f))
* **deps:** bump @hono/node-server from 2.0.8 to 2.0.10 ([#48](https://github.com/MrMarble/dilna/issues/48)) ([8dd4960](https://github.com/MrMarble/dilna/commit/8dd4960a1cf6499aaaad82f0117a201a3532f25f))
* **deps:** bump hono from 4.12.28 to 4.12.34 ([#49](https://github.com/MrMarble/dilna/issues/49)) ([90e3a26](https://github.com/MrMarble/dilna/commit/90e3a26e0607cc12f27d5077bd61a8c87659a529))
* **deps:** bump nanoid from 3.3.15 to 6.0.1 ([#50](https://github.com/MrMarble/dilna/issues/50)) ([ead0c4f](https://github.com/MrMarble/dilna/commit/ead0c4fc07255a086a5261788db43abc47d76c89))
* **deps:** pin all "latest" specs and clear vulnerable transitives ([da386ff](https://github.com/MrMarble/dilna/commit/da386ff5ea2bb16061cde1fe1c7086b3a04fd6dc))
* initial commit ([ea1f221](https://github.com/MrMarble/dilna/commit/ea1f22143cfbce9786689157ccf1ddbee385e631))
* **main:** release 0.5.0 ([#31](https://github.com/MrMarble/dilna/issues/31)) ([f5d0533](https://github.com/MrMarble/dilna/commit/f5d0533debeafa7c5e5d86c799aae5d112db2d9a))
* **main:** release 0.5.1 ([#45](https://github.com/MrMarble/dilna/issues/45)) ([177d8d9](https://github.com/MrMarble/dilna/commit/177d8d9d32cf651de75de7c59854afd648c22a51))
* **main:** release 0.5.2 ([#47](https://github.com/MrMarble/dilna/issues/47)) ([8efbfc6](https://github.com/MrMarble/dilna/commit/8efbfc6c741007f5b8b77e13cae3e854c4d33eb6))
* **main:** release dilna 0.6.0 ([#63](https://github.com/MrMarble/dilna/issues/63)) ([d9c6b5e](https://github.com/MrMarble/dilna/commit/d9c6b5e1e320b1348c70b29e72475b470af55234))
* push claude file ([6132226](https://github.com/MrMarble/dilna/commit/6132226a670d108ea31d2850e764630572af7ed1))

## [0.6.0](https://github.com/MrMarble/dilna/compare/dilna-v0.5.2...dilna-v0.6.0) (2026-08-12)


### Features

* **agents:** add ClaudeAgent adapter backed by @anthropic-ai/claude-agent-sdk ([1e6763d](https://github.com/MrMarble/dilna/commit/1e6763d41a27413ce35628a2eb692f88c73a8872))
* **agents:** give Claude sessions dilna-specific context via systemPrompt ([#22](https://github.com/MrMarble/dilna/issues/22)) ([18948d6](https://github.com/MrMarble/dilna/commit/18948d625c9ebab324ca7e000c6845ed46538f3e))
* **agents:** give sessions a self-serve toolchain via mise ([#16](https://github.com/MrMarble/dilna/issues/16)) ([65c4c0b](https://github.com/MrMarble/dilna/commit/65c4c0b7031f1c4af84201d3bf3436fd320f1491))
* **chat:** implement the agent-chat event-protocol contract (ADR-0016) ([#43](https://github.com/MrMarble/dilna/issues/43)) ([461b399](https://github.com/MrMarble/dilna/commit/461b39957ca470abdcb8891aaf7d96fa58e4d35e))
* **chat:** opencode serve integration with SSE-streamed chat UI ([f0f097e](https://github.com/MrMarble/dilna/commit/f0f097e5848ec472a36f0c291f46f34cb80def9b))
* **chat:** render assistant replies as markdown ([6e982f1](https://github.com/MrMarble/dilna/commit/6e982f14ad54fc944676b13b69b9ab6ddf363755))
* **deploy:** add single-container Docker image ([6387315](https://github.com/MrMarble/dilna/commit/63873158502c197275397a29a5a085faef227976))
* **docker:** add GitHub CLI (gh) with GH_TOKEN host-passthrough auth ([#24](https://github.com/MrMarble/dilna/issues/24)) ([d8a8cbc](https://github.com/MrMarble/dilna/commit/d8a8cbc5ce6a47ce08b23c0775002ee006d6eef6))
* **docker:** derive git commit identity from authenticated gh account ([#25](https://github.com/MrMarble/dilna/issues/25)) ([71cec50](https://github.com/MrMarble/dilna/commit/71cec5060e259c9818a189cdd5b2614726a950be))
* **repo:** implement repo cloning + sidebar with repo list and new-repo dialog ([f7f6fd8](https://github.com/MrMarble/dilna/commit/f7f6fd8023199e9989f68d5ffb52ec86a9dbbb17))
* **repos:** pull default branch from origin on sidebar refresh ([65f86ef](https://github.com/MrMarble/dilna/commit/65f86efe51e7e809ee87d88a123b2cd2638e923a))
* scaffold monorepo, glossary, ADRs, and stubbed services ([df79de9](https://github.com/MrMarble/dilna/commit/df79de9bf609ab4a7d628bd24b58a9dc3b214d0f))
* **session:** worktree-backed sessions with sidebar sessions list and CRUD ([27071d7](https://github.com/MrMarble/dilna/commit/27071d73c9424238f7a43d935174e10a3139bdf8))
* **sidebar:** add account-wide plan rate-limit footer ([bffdc9b](https://github.com/MrMarble/dilna/commit/bffdc9ba1814a028e27eb3dc3071e7fca82946f0))
* small improvements and usage progress bar ([15ef761](https://github.com/MrMarble/dilna/commit/15ef761035353f77d5a5c9360c809ef7ba36fbef))
* **web:** add agent selector to new-session creation ([fb8cfc3](https://github.com/MrMarble/dilna/commit/fb8cfc3cd0e35b46019b83e72eb9595cb6040ec7))
* **web:** add changed-files panel ([be16371](https://github.com/MrMarble/dilna/commit/be1637161dcf9c0eee83f9f5b77c81eca11b048b))
* **web:** add dark mode toggle to sidebar ([920cb27](https://github.com/MrMarble/dilna/commit/920cb271865e5ea24d50d3ae05ea7cb8a5b40111))
* **web:** add per-session token usage badge ([c6734a5](https://github.com/MrMarble/dilna/commit/c6734a55d42b68183843c8c763697406262e04f1)), closes [#10](https://github.com/MrMarble/dilna/issues/10)
* **web:** create sessions directly instead of via confirmation dialog ([2733ba2](https://github.com/MrMarble/dilna/commit/2733ba2b38d39a583c35d14e875177efe0762c06))
* **web:** mobile responsive layout for sidebar and changed-files panel ([f4816bf](https://github.com/MrMarble/dilna/commit/f4816bf552951530b60f159978ef7527e81db3c2)), closes [#12](https://github.com/MrMarble/dilna/issues/12)
* **web:** redesign sidebar and chat window per UI draft ([2f61c28](https://github.com/MrMarble/dilna/commit/2f61c28cacdd4c990a9bfdda33cc7bf0e4e5b5cf))
* **web:** show app version and commit info next to the dilna header ([ee5dbd1](https://github.com/MrMarble/dilna/commit/ee5dbd182494adfed2d9ec2002b5a6750cb3489c))


### Bug Fixes

* **agents:** distinguish a silent no-data usage pull from a thrown error ([#26](https://github.com/MrMarble/dilna/issues/26)) ([744f56c](https://github.com/MrMarble/dilna/commit/744f56c6612e9df7c8f46104a8a52946aa477b10))
* **agents:** grant worktree's shared git dir write access in sandbox ([#15](https://github.com/MrMarble/dilna/issues/15)) ([01b4aee](https://github.com/MrMarble/dilna/commit/01b4aee5ae0d2eac00143f606c8156c8039dae60))
* **agents:** log per-window shape from the OAuth usage endpoint pull ([#44](https://github.com/MrMarble/dilna/issues/44)) ([03c64fc](https://github.com/MrMarble/dilna/commit/03c64fc016378626866d3edbf7de409f8ab20d14))
* **agents:** log rate-limit usage pull failures instead of swallowing them silently ([#23](https://github.com/MrMarble/dilna/issues/23)) ([93f0469](https://github.com/MrMarble/dilna/commit/93f04698f1c8d0ab8f5a8972ab641b42d6e84995))
* **agents:** merge Claude's per-tool-round messages into one turn ([ab9928a](https://github.com/MrMarble/dilna/commit/ab9928a3edf0027326652a367fc2870adbc4e611))
* **agents:** migrate sandboxing from bubblewrap to sandlock ([9bbc82b](https://github.com/MrMarble/dilna/commit/9bbc82b5bdf8de63298cb8d0feb695ffdde3d0c1))
* **agents:** pre-trust the worktree so mise shims don't break on an untrusted mise.toml ([#20](https://github.com/MrMarble/dilna/issues/20)) ([c9c300b](https://github.com/MrMarble/dilna/commit/c9c300b7156c634a1023f660a2319b49a06dd781))
* **agents:** replace sandlock with Claude Code's built-in sandbox ([897b1ba](https://github.com/MrMarble/dilna/commit/897b1bacce611f02a30be59018489fcca3c41c94))
* **agents:** revert broken sandlock read confinement, improve crash logging ([d8e788e](https://github.com/MrMarble/dilna/commit/d8e788e132f0ac7297d123895cf447b5e72941fe))
* **agents:** sandbox agent processes to their worktree via bubblewrap ([7fcfef1](https://github.com/MrMarble/dilna/commit/7fcfef1a9dd8fe8a42af6e78172fea77973fe308))
* **agents:** stop ClaudeAgent from deadlocking on session start ([fc8f02e](https://github.com/MrMarble/dilna/commit/fc8f02e542bd7e0610a7742994d0f683de97e4bd))
* **chat:** coerce opencode error payloads to strings, flush live messages on idle/crash ([fa691f8](https://github.com/MrMarble/dilna/commit/fa691f80e23a9dea3dee234461bf124c318f165a))
* **chat:** eliminate flicker between live and persisted message states ([acc5d2b](https://github.com/MrMarble/dilna/commit/acc5d2b4cb27eba098f622a14c37e64d80ea08fa))
* **chat:** eliminate message flicker with optimistic placeholders and group tool calls ([18cf351](https://github.com/MrMarble/dilna/commit/18cf351fa0f069d7b1e8d3f1b1b52754a7668d8d))
* **chat:** message ordering, follow-the-stream autoscroll, fade clearance ([2820f17](https://github.com/MrMarble/dilna/commit/2820f17f52213e5015f48ef793a768efe4d205dd))
* **chat:** show tool call input/output when a tool group is expanded ([d60906c](https://github.com/MrMarble/dilna/commit/d60906c070c6e5009877674403e866f4d0c354fb))
* **docker:** make mise install failures fail the build, not surface as COPY errors ([fd43aba](https://github.com/MrMarble/dilna/commit/fd43aba0ce26265feeaec891e4649ac2af5fabfb))
* **docker:** run container as non-root, fix sandbox seccomp, bake real version/commit ([8631718](https://github.com/MrMarble/dilna/commit/863171865c7bfe784822c259c931dcb2763b2383))
* **repos:** give bare clones a normal-clone git contract for session worktrees ([#28](https://github.com/MrMarble/dilna/issues/28)) ([c199d45](https://github.com/MrMarble/dilna/commit/c199d45acdaff6dc78c6560dd0a5a307996bf154))
* **server:** persist Claude session storage, recover unresumable sessions ([0c43b17](https://github.com/MrMarble/dilna/commit/0c43b17e7b2a7c57eb9dff7e26173e8c80d5673e))
* **server:** stop sessions from wedging permanently on a stalled turn ([87c861a](https://github.com/MrMarble/dilna/commit/87c861ab46b543c5c03999e6f89de3f70b0f4c94))
* **sessions:** give new sessions a distinguishable default title ([4627b59](https://github.com/MrMarble/dilna/commit/4627b597eb96e6779306e8c345c1acd5173b8d77))
* **sessions:** log raw utilization from push rate_limit_events ([#46](https://github.com/MrMarble/dilna/issues/46)) ([fb194a9](https://github.com/MrMarble/dilna/commit/fb194a93d62df4a39af2829d7cdf04800dc15172))
* **sessions:** make chat history survive interruptions and replay in-flight turns (ADR-0014) ([#27](https://github.com/MrMarble/dilna/issues/27)) ([b3e9f47](https://github.com/MrMarble/dilna/commit/b3e9f479c28e9b4e3924005a8419a0ccafd75517))
* **sessions:** persist per-session token totals so the badge survives reloads ([5fd357c](https://github.com/MrMarble/dilna/commit/5fd357c48407b0b81880003b515f24a1452f50fe))
* **sessions:** persist user message immediately instead of at turn end ([2f40eac](https://github.com/MrMarble/dilna/commit/2f40eaca89ed2531c1513e0d2e531d3100c67108))
* **sessions:** source the usage bar from the claude.ai OAuth usage endpoint (ADR-0015) ([#29](https://github.com/MrMarble/dilna/issues/29)) ([3f1deb1](https://github.com/MrMarble/dilna/commit/3f1deb104bb6852f5ffb6c4055ea009dea79a084))
* **sidebar:** source plan rate limits from the SDK usage pull and persist them ([39c2424](https://github.com/MrMarble/dilna/commit/39c242429fb6b035c23176d820e85e7228f66bb9))
* **sidebar:** stop dropping real rate-limit data for OAuth accounts ([c416c7b](https://github.com/MrMarble/dilna/commit/c416c7ba93e68a15d05a07c18ec58d3e934aa0bf))
* **web:** declutter mobile chat header by relocating delete/tokens into sheets ([7675dbd](https://github.com/MrMarble/dilna/commit/7675dbdbff2033d0459d39ae9d58a29d2d2f56b3))
* **web:** fix mobile viewport height, add PWA manifest ([7aeab01](https://github.com/MrMarble/dilna/commit/7aeab016597b6e7f8d7ec687749fa2cac9be4cfc))
* **web:** interleave tool calls and text in live message stream ([57d3662](https://github.com/MrMarble/dilna/commit/57d36626b956b0f32730e48a6b3a247e60724ea9))
* **web:** invert mobile Enter-key behavior to insert newline instead of sending ([#14](https://github.com/MrMarble/dilna/issues/14)) ([80e4ac6](https://github.com/MrMarble/dilna/commit/80e4ac6a576593a6c8445d942d73eaa4dceb29d3))
* **web:** invert mobile Enter-key behavior to insert newline instead of sending ([#17](https://github.com/MrMarble/dilna/issues/17)) ([2ec8d82](https://github.com/MrMarble/dilna/commit/2ec8d820af4ef9f8bbf49d18de487eba1e10883d))


### Dependencies

* add project verify skill with isolated-instance recipe ([369ae75](https://github.com/MrMarble/dilna/commit/369ae75d81fdf0f733d50c8e2c9b6c9e59f5e04e))
* add release-please manifest config for bot dependency releases ([#62](https://github.com/MrMarble/dilna/issues/62)) ([5ccbf8a](https://github.com/MrMarble/dilna/commit/5ccbf8a065ef703a834393c4fa296218edd7458e))
* bump 0.2.1 version ([541e62d](https://github.com/MrMarble/dilna/commit/541e62ddff082652b10a918243290bbf2391866a))
* bump versión 0.2.0 ([54817ef](https://github.com/MrMarble/dilna/commit/54817efe3bfeda2ad6923c00078e1bb31120394c))
* Bump version from 0.4.0 to 0.4.1 ([d1e59f2](https://github.com/MrMarble/dilna/commit/d1e59f2842b7f29ebeacb0a8d24d5f741cdd773d))
* bump version to 0.1.1 ([e56600a](https://github.com/MrMarble/dilna/commit/e56600a175e640cad8f195688087c99311feb587))
* bump version to 0.1.2 ([cd12463](https://github.com/MrMarble/dilna/commit/cd124636230fb635aca2fd75e4a72d22e570a9db))
* bump version to 0.1.3 ([f667cd9](https://github.com/MrMarble/dilna/commit/f667cd99cded1a9bf5976cecdba0739ea7fe6aad))
* bump version to 0.3.0 ([464113b](https://github.com/MrMarble/dilna/commit/464113b72e5975bc3177adac5948d2aed54e4da6))
* bump version to 0.4.0 ([0bfd8ce](https://github.com/MrMarble/dilna/commit/0bfd8ceb002628b982edbd6a22683d73f3415a56))
* **deps:** bump @hono/node-server from 1.19.14 to 2.1.0 ([#58](https://github.com/MrMarble/dilna/issues/58)) ([3625e81](https://github.com/MrMarble/dilna/commit/3625e8106f04f8ca52e20a8b971d268289dff24f))
* **deps:** bump @hono/node-server from 2.0.8 to 2.0.10 ([#48](https://github.com/MrMarble/dilna/issues/48)) ([8dd4960](https://github.com/MrMarble/dilna/commit/8dd4960a1cf6499aaaad82f0117a201a3532f25f))
* **deps:** bump hono from 4.12.28 to 4.12.34 ([#49](https://github.com/MrMarble/dilna/issues/49)) ([90e3a26](https://github.com/MrMarble/dilna/commit/90e3a26e0607cc12f27d5077bd61a8c87659a529))
* **deps:** bump nanoid from 3.3.15 to 6.0.1 ([#50](https://github.com/MrMarble/dilna/issues/50)) ([ead0c4f](https://github.com/MrMarble/dilna/commit/ead0c4fc07255a086a5261788db43abc47d76c89))
* **deps:** pin all "latest" specs and clear vulnerable transitives ([da386ff](https://github.com/MrMarble/dilna/commit/da386ff5ea2bb16061cde1fe1c7086b3a04fd6dc))
* initial commit ([ea1f221](https://github.com/MrMarble/dilna/commit/ea1f22143cfbce9786689157ccf1ddbee385e631))
* **main:** release 0.5.0 ([#31](https://github.com/MrMarble/dilna/issues/31)) ([f5d0533](https://github.com/MrMarble/dilna/commit/f5d0533debeafa7c5e5d86c799aae5d112db2d9a))
* **main:** release 0.5.1 ([#45](https://github.com/MrMarble/dilna/issues/45)) ([177d8d9](https://github.com/MrMarble/dilna/commit/177d8d9d32cf651de75de7c59854afd648c22a51))
* **main:** release 0.5.2 ([#47](https://github.com/MrMarble/dilna/issues/47)) ([8efbfc6](https://github.com/MrMarble/dilna/commit/8efbfc6c741007f5b8b77e13cae3e854c4d33eb6))
* push claude file ([6132226](https://github.com/MrMarble/dilna/commit/6132226a670d108ea31d2850e764630572af7ed1))

## [0.5.2](https://github.com/MrMarble/dilna/compare/v0.5.1...v0.5.2) (2026-07-16)


### Bug Fixes

* **sessions:** log raw utilization from push rate_limit_events ([#46](https://github.com/MrMarble/dilna/issues/46)) ([fb194a9](https://github.com/MrMarble/dilna/commit/fb194a93d62df4a39af2829d7cdf04800dc15172))

## [0.5.1](https://github.com/MrMarble/dilna/compare/v0.5.0...v0.5.1) (2026-07-15)


### Bug Fixes

* **agents:** log per-window shape from the OAuth usage endpoint pull ([#44](https://github.com/MrMarble/dilna/issues/44)) ([03c64fc](https://github.com/MrMarble/dilna/commit/03c64fc016378626866d3edbf7de409f8ab20d14))

## [0.5.0](https://github.com/MrMarble/dilna/compare/v0.4.1...v0.5.0) (2026-07-15)


### Features

* **chat:** implement the agent-chat event-protocol contract (ADR-0016) ([#43](https://github.com/MrMarble/dilna/issues/43)) ([461b399](https://github.com/MrMarble/dilna/commit/461b39957ca470abdcb8891aaf7d96fa58e4d35e))


### Bug Fixes

* **sessions:** source the usage bar from the claude.ai OAuth usage endpoint (ADR-0015) ([#29](https://github.com/MrMarble/dilna/issues/29)) ([3f1deb1](https://github.com/MrMarble/dilna/commit/3f1deb104bb6852f5ffb6c4055ea009dea79a084))
