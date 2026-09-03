#!/usr/bin/env node
/**
 * Docs-freshness CI gate:
 *  a. README "项目布局" block lists real paths only.
 *  b. docs/api-verification.md's stated pi version matches `pi --version`.
 *  c. ADR numbers in docs/design-decisions.md are sequential (ADR-001..N, no gaps).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
let failures = 0;
const fail = (msg) => {
	console.error(`✖ ${msg}`);
	failures++;
};
const ok = (msg) => console.log(`✔ ${msg}`);

// (a) README layout block ↔ filesystem
const readme = readFileSync(join(root, "README.md"), "utf8");
const layoutMatch = /## 项目布局\s*```\n([\s\S]*?)```/.exec(readme);
if (!layoutMatch) {
	fail("README.md: no '## 项目布局' fenced block found");
} else {
	const paths = layoutMatch[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => l.split(/\s{2,}| # /)[0].trim());
	for (const p of paths) {
		if (existsSync(join(root, p))) ok(`layout: ${p}`);
		else fail(`layout: ${p} listed in README but does not exist`);
	}
}

// (b) pi version in api-verification.md vs installed
const apiDoc = readFileSync(join(root, "docs/api-verification.md"), "utf8");
const docVersion =
	/pi 版本:\s*([\d.]+)/.exec(apiDoc)?.[1] ?? /pi ([\d.]+)/.exec(apiDoc)?.[1];
let realVersion;
try {
	realVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
} catch {
	realVersion = undefined;
}
if (!docVersion) fail("api-verification.md: no pi version declared");
else if (!realVersion)
	ok(`pi not on PATH — skipping version comparison (doc says ${docVersion})`);
else if (docVersion !== realVersion)
	fail(`api-verification.md says pi ${docVersion}, installed ${realVersion}`);
else ok(`pi version ${docVersion} matches`);

// (c) ADR numbering sequential
const adrs = [
	...readFileSync(join(root, "docs/design-decisions.md"), "utf8").matchAll(
		/^## ADR-(\d+)/gm,
	),
]
	.map((m) => Number(m[1]))
	.sort((a, b) => a - b);
if (adrs.length === 0) {
	fail("design-decisions.md: no ADR headings found");
} else {
	for (let i = 0; i < adrs.length; i++) {
		if (adrs[i] !== i + 1) {
			fail(
				`ADR numbering gap: expected ADR-${String(i + 1).padStart(3, "0")}, got ADR-${String(adrs[i]).padStart(3, "0")}`,
			);
			break;
		}
	}
	if (failures === 0 || adrs.every((n, i) => n === i + 1))
		ok(`ADR-001..ADR-${String(adrs.at(-1)).padStart(3, "0")} sequential`);
}

if (failures > 0) process.exit(1);
console.log("docs fresh");
