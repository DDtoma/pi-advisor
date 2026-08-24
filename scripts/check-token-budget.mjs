#!/usr/bin/env node
/**
 * Token-budget CI gate (architecture §4.4/§9): every advisor system prompt —
 * from WATCHDOG.yml samples/fixtures or embedded in source — must render to
 * ≤ 5000 characters.
 *
 * Checks:
 *  1. `prompt: |` / `prompt: |-` block strings in WATCHDOG.example.yml and
 *     test/fixtures/*.yml (indentation-based extraction, matching the subset
 *     parser's block-string semantics).
 *  2. Quoted/template string literals > BUDGET chars anywhere in src/ or
 *     extensions/ (would catch an over-budget embedded prompt).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUDGET = 5000;
const root = new URL("..", import.meta.url).pathname;
let failures = 0;

function check(label, text) {
	if (text.length > BUDGET) {
		console.error(`✖ ${label}: ${text.length} chars > ${BUDGET}`);
		failures++;
	} else {
		console.log(`✔ ${label}: ${text.length} chars`);
	}
}

/** Extract literal block-string values for a given key from YAML text. */
function extractBlockStrings(yaml, key) {
	const lines = yaml.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = new RegExp(`^(\\s*)${key}:\\s*\\|[-+]?\\s*$`).exec(lines[i]);
		if (!m) continue;
		const keyIndent = m[1].length;
		const block = [];
		let blockIndent = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (line.trim() === "") {
				block.push("");
				continue;
			}
			const indent = line.length - line.trimStart().length;
			if (indent <= keyIndent) break;
			if (blockIndent === -1) blockIndent = indent;
			block.push(line.slice(Math.min(blockIndent, line.length)).trimEnd());
		}
		while (block.length > 0 && block[block.length - 1] === "") block.pop();
		out.push(block.join("\n"));
	}
	return out;
}

const yamlFiles = [
	join(root, "WATCHDOG.example.yml"),
	...readdirSync(join(root, "test/fixtures"))
		.filter((f) => f.endsWith(".yml"))
		.map((f) => join(root, "test/fixtures", f)),
];
for (const file of yamlFiles) {
	const text = readFileSync(file, "utf8");
	const rel = file.slice(root.length);
	extractBlockStrings(text, "prompt").forEach((p, i) => check(`${rel} prompt[${i}]`, p));
}

// Embedded prompts: any single string/template literal over budget in src|extensions.
const LITERAL_RE = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gs;
for (const dir of ["src", "extensions"]) {
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".ts")) files.push(full);
		}
	};
	const files = [];
	walk(join(root, dir));
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(LITERAL_RE)) {
			const body = m[0].slice(1, -1);
			if (body.length > BUDGET) {
				const line = text.slice(0, m.index).split("\n").length;
				check(`${file.slice(root.length)}:${line} string literal`, body);
			}
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} prompt(s) over the ${BUDGET}-char budget`);
	process.exit(1);
}
console.log("\nall prompts within budget");
