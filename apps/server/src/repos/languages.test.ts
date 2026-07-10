import { describe, expect, it } from "vitest";
import { languagesFromFiles } from "./languages";

describe("languagesFromFiles", () => {
	it("splits by byte share across recognized extensions, descending", () => {
		const stats = languagesFromFiles([
			{ path: "src/app.ts", size: 600 },
			{ path: "src/util.ts", size: 150 },
			{ path: "styles/main.css", size: 250 },
		]);
		expect(stats).toEqual([
			{ name: "TypeScript", pct: 75 },
			{ name: "CSS", pct: 25 },
		]);
	});

	it("ignores unrecognized files and generated lockfiles entirely", () => {
		const stats = languagesFromFiles([
			{ path: "README.md", size: 5000 },
			{ path: "pnpm-lock.yaml", size: 90000 },
			{ path: "logo.png", size: 40000 },
			{ path: "src/index.ts", size: 100 },
		]);
		expect(stats).toEqual([{ name: "TypeScript", pct: 100 }]);
	});

	it("counts real YAML files while still skipping lockfiles", () => {
		const stats = languagesFromFiles([
			{ path: "k8s/deploy.yaml", size: 300 },
			{ path: "app/config.yml", size: 100 },
			{ path: "pnpm-lock.yaml", size: 90000 },
		]);
		expect(stats).toEqual([{ name: "YAML", pct: 100 }]);
	});

	it("does not treat dotfiles as extensions", () => {
		expect(languagesFromFiles([{ path: ".ts", size: 10 }])).toEqual([]);
		expect(languagesFromFiles([{ path: "dir/.gitignore", size: 10 }])).toEqual(
			[],
		);
	});

	it("returns [] when nothing is recognized", () => {
		expect(languagesFromFiles([{ path: "data.csv", size: 100 }])).toEqual([]);
		expect(languagesFromFiles([])).toEqual([]);
	});

	it("maps multiple extensions of one language into a single entry", () => {
		const stats = languagesFromFiles([
			{ path: "a.jsx", size: 50 },
			{ path: "b.mjs", size: 50 },
		]);
		expect(stats).toEqual([{ name: "JavaScript", pct: 100 }]);
	});
});
