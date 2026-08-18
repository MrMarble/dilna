#!/usr/bin/env node
// ponytail: single-page check, not a crawler — good enough for "does this page load cleanly".
import { chromium } from "@playwright/test";

const url = process.argv[2];
const screenshotPath = process.argv[3];

if (!url) {
	console.error("usage: node scripts/check-page.mjs <url> [screenshot.png]");
	process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];

page.on("console", (msg) => {
	if (msg.type() === "error") errors.push(`[console] ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) =>
	errors.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`),
);

try {
	const response = await page.goto(url, { waitUntil: "networkidle" });
	console.log(`status: ${response?.status()}`);
	console.log(`title: ${await page.title()}`);

	if (screenshotPath) {
		await page.screenshot({ path: screenshotPath, fullPage: true });
		console.log(`screenshot: ${screenshotPath}`);
	}

	if (errors.length) {
		console.log(`\n${errors.length} error(s):`);
		for (const e of errors) console.log(`  ${e}`);
	}
} catch (err) {
	console.error(`navigation failed: ${err.message}`);
	errors.push(String(err.message));
} finally {
	await browser.close();
}

process.exit(errors.length ? 1 : 0);
