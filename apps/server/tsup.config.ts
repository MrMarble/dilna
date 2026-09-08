import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	outDir: "dist",
	// `@dilna/shared` ships raw `.ts` source with no compiled output (it's
	// meant to be a type-only contract — see packages/shared/package.json's
	// `exports`), and the production Docker image never copies
	// packages/shared into the runtime stage, only apps/server/dist and its
	// own node_modules. tsup's CLI has no `--no-external` flag, only
	// `--external` (the opposite), so bundling this one workspace package's
	// code directly into dist/index.js — instead of leaving it as an
	// unresolved runtime import like every real node_modules dependency —
	// needs a config file rather than a CLI flag.
	noExternal: ["@dilna/shared"],
});
