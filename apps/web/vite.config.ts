import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadBuildInfo } from "./build-info";

const apiTarget = process.env.DILNA_API_URL ?? "http://localhost:3001";
const { appVersion, commitHash, commitDate } = loadBuildInfo();

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		__COMMIT_HASH__: JSON.stringify(commitHash),
		__COMMIT_DATE__: JSON.stringify(commitDate),
	},
	server: {
		port: 5174,
		proxy: {
			"/api": {
				target: apiTarget,
				changeOrigin: true,
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
