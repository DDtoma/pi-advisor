import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sliceEntries } from "../src/advisor/cursor.ts";
import { AdvisorRoster } from "../src/advisor/roster.ts";
import type { Cursor, DeltaSource, Injector, ModelCaller, SessionEntryLike } from "../src/advisor/types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function deps(globalConfigPath: string, projectRoot: string) {
	const source: DeltaSource & { branch: SessionEntryLike[] } = {
		branch: [],
		slice(cursor: Cursor) {
			return sliceEntries(this.branch, cursor);
		},
		length() {
			return this.branch.length;
		},
	};
	const caller: ModelCaller = {
		complete: () => Promise.resolve({ stopReason: "stop", content: [] }),
	};
	const injector: Injector = {
		steer: () => {},
	};
	return { source, caller, injector, cwd: "/tmp", globalConfigPath, projectRoot };
}

describe("AdvisorRoster", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-advisor-roster-"));
		mkdirSync(join(dir, "global"), { recursive: true });
		mkdirSync(join(dir, "project"), { recursive: true });
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	function writeConfigs(globalFixture: string | undefined, projectFixture: string | undefined) {
		const globalPath = join(dir, "global", "WATCHDOG.yml");
		const projectDir = join(dir, "project");
		for (const p of [globalPath, join(projectDir, "WATCHDOG.yml")]) {
			rmSync(p, { force: true });
		}
		if (globalFixture) {
			writeFileSync(globalPath, readFixture(globalFixture));
		}
		if (projectFixture) {
			writeFileSync(join(projectDir, "WATCHDOG.yml"), readFixture(projectFixture));
		}
		return { globalPath, projectDir };
	}
	function readFixture(name: string): string {
		return readFileSync(join(fixtures, name), "utf8");
	}

	it("discovers global only when no project config", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", undefined);
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		const report = roster.load();
		assert.equal(report.advisorCount, 2);
		assert.equal(report.errors.length, 0);
		assert.deepEqual(
			roster.status().map((s) => s.slug).sort(),
			["global-only", "global-sec"],
		);
	});

	it("project overrides same-slug global advisor", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", "watchdog-project.yml");
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		const report = roster.load();
		assert.equal(report.advisorCount, 3);
		// Cursor jumped to branch end — a turn with no new entries does nothing.
		roster.onTurnEnd(0);
		assert.equal(roster.status().every((s) => s.queued === 0), true);
	});

	it("broken project config is reported, global still loads", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", "watchdog-invalid-version.yml");
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		const report = roster.load();
		assert.equal(report.advisorCount, 2);
		assert.equal(report.errors.length, 1);
		assert.match(report.errors[0]!, /version/);
	});

	it("slug conflict inside one file rejects that file", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-invalid-dup-slug.yml", undefined);
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		const report = roster.load();
		assert.equal(report.advisorCount, 0);
		assert.match(report.errors[0]!, /duplicate advisor slug/);
	});

	it("no configs at all → zero advisors, no errors", () => {
		const { globalPath, projectDir } = writeConfigs(undefined, undefined);
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		const report = roster.load();
		assert.equal(report.advisorCount, 0);
		assert.equal(report.errors.length, 0);
		assert.equal(roster.runtime, undefined);
		roster.onTurnEnd(0); // no-op, must not throw
	});

	it("usageTotals aggregates across advisors", async () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", undefined);
		const d = deps(globalPath, projectDir);
		d.caller = {
			complete: () =>
				Promise.resolve({
					stopReason: "stop",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 10, output: 5 },
				}),
		};
		const roster = new AdvisorRoster(d);
		roster.load();
		d.source.branch.push({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "work" }] },
		});
		roster.onTurnEnd(0);
		await roster.settle();
		const totals = roster.usageTotals();
		assert.equal(totals.calls, 2); // one complete per advisor
		assert.equal(totals.input, 20);
	});

	it("setEnabled / reset delegate by slug", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", undefined);
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		roster.load();
		assert.equal(roster.setEnabled("global-sec", false), true);
		assert.equal(roster.setEnabled("nope", false), false);
		assert.equal(roster.status().find((s) => s.slug === "global-sec")!.enabled, false);
		roster.reset("global-sec");
		assert.equal(roster.status().find((s) => s.slug === "global-sec")!.halted, false);
	});

	it("previewNext reports disabled and would-trigger states", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", undefined);
		const d = deps(globalPath, projectDir);
		const roster = new AdvisorRoster(d);
		roster.load();
		// No new entries since load (cursors at end).
		assert.ok(roster.previewNext().every((p) => !p.wouldTrigger && p.reason === "no new entries"));
		d.source.branch.push({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "new work" }] },
		});
		assert.ok(roster.previewNext().every((p) => p.wouldTrigger));
	});

	it("reload swaps the runtime (config change picked up)", () => {
		const { globalPath, projectDir } = writeConfigs("watchdog-global.yml", undefined);
		const roster = new AdvisorRoster(deps(globalPath, projectDir));
		roster.load();
		assert.equal(roster.status().length, 2);
		// Replace global config with a single-advisor one.
		writeFileSync(globalPath, 'version: "1"\nadvisors:\n  - slug: solo\n    model: p/m\n    prompt: x\n');
		const report = roster.load();
		assert.equal(report.advisorCount, 1);
		assert.equal(roster.status()[0]!.slug, "solo");
	});
});
