import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ConfigError,
	PROMPT_BUDGET_CHARS,
	loadConfigFile,
	mergeConfigs,
	parseConfig,
	parseYamlSubset,
} from "../src/advisor/config.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function fixture(name: string): string {
	return readFileSync(join(fixtures, name), "utf8");
}

describe("parseYamlSubset", () => {
	it("parses nested maps", () => {
		const v = parseYamlSubset("a:\n  b: 1\n  c: two\n") as Record<string, unknown>;
		assert.deepEqual(v, { a: { b: 1, c: "two" } });
	});
	it("parses scalars", () => {
		const v = parseYamlSubset('n: 42\nf: 3.5\nb: true\nb2: false\ns: hello\nq: "quoted"\nnullv: null\n') as Record<string, unknown>;
		assert.deepEqual(v, { n: 42, f: 3.5, b: true, b2: false, s: "hello", q: "quoted", nullv: null });
	});
	it("parses flow lists", () => {
		const v = parseYamlSubset('l: [read, "grep", 3]\n') as Record<string, unknown>;
		assert.deepEqual(v, { l: ["read", "grep", 3] });
	});
	it("parses block sequences of maps", () => {
		const v = parseYamlSubset("- name: a\n  x: 1\n- name: b\n  x: 2\n") as unknown[];
		assert.deepEqual(v, [{ name: "a", x: 1 }, { name: "b", x: 2 }]);
	});
	it("parses literal block strings preserving # and quotes", () => {
		const v = parseYamlSubset('p: |\n  line one # not a comment\n  "quoted"\n') as Record<string, unknown>;
		assert.equal(v["p"], 'line one # not a comment\n"quoted"\n');
	});
	it("block string |- strips trailing newline", () => {
		const v = parseYamlSubset("p: |-\n  a\n  b\n") as Record<string, unknown>;
		assert.equal(v["p"], "a\nb");
	});
	it("skips full-line and trailing comments", () => {
		const v = parseYamlSubset("# top\na: 1 # trailing\n") as Record<string, unknown>;
		assert.deepEqual(v, { a: 1 });
	});
	it("rejects tab indentation", () => {
		assert.throws(() => parseYamlSubset("a:\n\tb: 1\n"), ConfigError);
	});
});

describe("parseConfig (schema validation)", () => {
	it("parses the valid fixture with defaults applied", () => {
		const cfg = parseConfig(fixture("watchdog-valid.yml"), "watchdog-valid.yml");
		assert.equal(cfg.version, "1");
		assert.equal(cfg.project, "test-project");
		assert.equal(cfg.advisors.length, 2);

		const sec = cfg.advisors[0]!;
		assert.equal(sec.slug, "security");
		assert.equal(sec.name, "Security");
		assert.equal(sec.model, "minimax-cn/MiniMax-M3:high");
		assert.deepEqual(sec.focus, ["**/*.ts", "**/*.sql"]);
		assert.deepEqual(sec.ignore, ["**/test/**"]);
		assert.deepEqual(sec.tools, ["read", "grep"]);
		assert.equal(sec.trigger.frequency, "per-update");
		assert.equal(sec.trigger.priority, "high");
		assert.equal(sec.maxTokens, 80000);
		assert.equal(sec.failurePolicy, "halt");
		assert.equal(sec.enabled, true);
		assert.ok(sec.prompt.includes("# hash characters"));
		assert.ok(sec.prompt.includes('"quotes"'));

		const cor = cfg.advisors[1]!;
		// Inherits defaults.model / defaults.maxTokens / defaults.failurePolicy.
		assert.equal(cor.model, "minimax-cn/MiniMax-M3");
		assert.equal(cor.maxTokens, 60000);
		assert.equal(cor.failurePolicy, "backoff");
		assert.equal(cor.trigger.frequency, "per-N-turns");
		assert.equal(cor.trigger.every, 3);
		assert.equal(cor.trigger.priority, "normal"); // default
		assert.equal(cor.enabled, false);
		assert.deepEqual(cor.tools, []); // default
		assert.ok(!cor.prompt.endsWith("\n"), "|- chomps trailing newline");
	});

	it("rejects unsupported version", () => {
		assert.throws(() => parseConfig(fixture("watchdog-invalid-version.yml")), /version "2"/);
	});

	it("rejects duplicate slugs", () => {
		assert.throws(() => parseConfig(fixture("watchdog-invalid-dup-slug.yml")), /duplicate advisor slug "dup"/);
	});

	it("rejects model without provider/ prefix", () => {
		assert.throws(() => parseConfig(fixture("watchdog-invalid-model.yml")), /provider\/model-id/);
	});

	it("rejects prompt over budget", () => {
		const big = "x".repeat(PROMPT_BUDGET_CHARS + 1);
		assert.throws(
			() => parseConfig(`version: "1"\nadvisors:\n  - slug: big\n    model: p/m\n    prompt: "${big}"\n`),
			/budget is 5000/,
		);
	});

	it("rejects missing prompt", () => {
		assert.throws(
			() => parseConfig('version: "1"\nadvisors:\n  - slug: x\n    model: p/m\n'),
			/prompt is required/,
		);
	});

	it("rejects invalid slug characters", () => {
		assert.throws(
			() => parseConfig('version: "1"\nadvisors:\n  - slug: "Bad_Slug"\n    model: p/m\n    prompt: x\n'),
			/\[a-z0-9-\]\+/,
		);
	});

	it("rejects non-readonly tools", () => {
		assert.throws(
			() => parseConfig('version: "1"\nadvisors:\n  - slug: x\n    model: p/m\n    prompt: x\n    tools: [read, edit]\n'),
			/"edit" is not a read-only tool/,
		);
	});

	it("per-N-turns requires every", () => {
		assert.throws(
			() =>
				parseConfig('version: "1"\nadvisors:\n  - slug: x\n    model: p/m\n    prompt: x\n    trigger:\n      frequency: per-N-turns\n'),
			/requires every: N/,
		);
	});

	it("rejects bad failurePolicy", () => {
		assert.throws(
			() => parseConfig('version: "1"\nadvisors:\n  - slug: x\n    model: p/m\n    prompt: x\n    failurePolicy: explode\n'),
			/halt \| backoff/,
		);
	});

	it("empty advisors list is fine", () => {
		const cfg = parseConfig('version: "1"\nadvisors: []\n');
		assert.deepEqual(cfg.advisors, []);
	});

	it("missing file returns undefined from loadConfigFile", () => {
		assert.equal(loadConfigFile(join(fixtures, "does-not-exist.yml")), undefined);
	});
});

describe("mergeConfigs", () => {
	it("project overrides same-slug global, keeps others", () => {
		const g = parseConfig(fixture("watchdog-global.yml"));
		const p = parseConfig(fixture("watchdog-project.yml"));
		const merged = mergeConfigs(g, p);
		assert.equal(merged.project, "my-project");
		assert.equal(merged.advisors.length, 3);
		const bySlug = new Map(merged.advisors.map((a) => [a.slug, a]));
		assert.equal(bySlug.get("global-sec")!.model, "project/model-c");
		assert.equal(bySlug.get("global-sec")!.prompt, "project override of global-sec");
		assert.equal(bySlug.get("global-only")!.model, "global/model-b");
		assert.equal(bySlug.get("project-only")!.model, "project/model-d");
	});

	it("handles missing sides", () => {
		const g = parseConfig(fixture("watchdog-global.yml"));
		assert.equal(mergeConfigs(g, undefined).advisors.length, 2);
		assert.equal(mergeConfigs(undefined, undefined).advisors.length, 0);
	});
});

describe("debug flag", () => {
	it("parses top-level debug: true", () => {
		const cfg = parseConfig(`version: "1"\ndebug: true\nadvisors: []\n`);
		assert.equal(cfg.debug, true);
	});

	it("debug defaults to unset and rejects non-booleans", () => {
		assert.equal(parseConfig(`version: "1"\nadvisors: []\n`).debug, undefined);
		assert.throws(() => parseConfig(`version: "1"\ndebug: "yes"\nadvisors: []\n`), /debug must be a boolean/);
	});

	it("mergeConfigs ORs the flag from either side", () => {
		const on = parseConfig(`version: "1"\ndebug: true\nadvisors: []\n`);
		const off = parseConfig(`version: "1"\nadvisors: []\n`);
		assert.equal(mergeConfigs(on, off).debug, true);
		assert.equal(mergeConfigs(off, on).debug, true);
		assert.equal(mergeConfigs(off, off).debug, undefined);
	});
});
