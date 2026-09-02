import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAdvisory, parseAdvisories, routeNote } from "../src/advisor/router.ts";
import { createInjector } from "../src/pi/inject.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Injector } from "../src/advisor/types.ts";

describe("formatAdvisory / parseAdvisories round-trip", () => {
	it("parses back advisor, severity, and text", () => {
		const text = formatAdvisory("Skeptic", { note: "line one\nline two", severity: "blocker" });
		const envs = parseAdvisories(text);
		assert.equal(envs.length, 1);
		assert.deepEqual(envs[0], { advisor: "Skeptic", severity: "blocker", text: "line one\nline two" });
	});

	it("parses a nit batch (multiple envelopes joined by blank line)", () => {
		const batch = [
			formatAdvisory("A", { note: "first", severity: "nit" }),
			formatAdvisory("B", { note: "second", severity: "concern" }),
		].join("\n\n");
		const envs = parseAdvisories(batch);
		assert.equal(envs.length, 2);
		assert.equal(envs[0]!.severity, "nit");
		assert.equal(envs[1]!.advisor, "B");
		assert.equal(envs[1]!.severity, "concern");
	});

	it("unescapes advisor attribute", () => {
		const text = formatAdvisory('Odd "Name" <x>', { note: "n", severity: "nit" });
		assert.equal(parseAdvisories(text)[0]!.advisor, 'Odd "Name" <x>');
	});

	it("coerces unknown severity to concern", () => {
		const envs = parseAdvisories('<advisory advisor="A" severity="wat">hi</advisory>');
		assert.equal(envs[0]!.severity, "concern");
	});

	it("returns [] for non-advisory content", () => {
		assert.deepEqual(parseAdvisories("just some text"), []);
	});
});

describe("routeNote channels", () => {
	function fakeInjector(): Injector & { calls: [string, string, unknown][] } {
		const calls: [string, string, unknown][] = [];
		return {
			calls,
			steer: (t, d) => void calls.push(["steer", t, d]),
		};
	}

	it("routes every severity to steer", () => {
		const inj = fakeInjector();
		routeNote(inj, "X", { note: "b", severity: "blocker" });
		routeNote(inj, "X", { note: "c", severity: "concern" });
		routeNote(inj, "X", { note: "n", severity: "nit" });
		assert.deepEqual(
			inj.calls.map(([ch]) => ch),
			["steer", "steer", "steer"],
		);
	});

	it("passes { fullNote } as details for any severity when the note was clamped", () => {
		const inj = fakeInjector();
		const clamped = { note: "n…", severity: "nit" as const, fullNote: "n".repeat(600) };
		const plain = { note: "c", severity: "concern" as const };
		routeNote(inj, "X", clamped);
		routeNote(inj, "X", plain);
		assert.deepEqual(inj.calls[0]![2], { fullNote: clamped.fullNote });
		assert.equal(inj.calls[1]![2], undefined, "no details when the note was not clamped");
	});
});

describe("createInjector sendMessage routing", () => {
	function fakePi(): ExtensionAPI & { sent: { message: unknown; options: unknown }[] } {
		const sent: { message: unknown; options: unknown }[] = [];
		return {
			sent,
			sendMessage: (message: unknown, options: unknown) => void sent.push({ message, options }),
		} as unknown as ExtensionAPI & { sent: { message: unknown; options: unknown }[] };
	}

	it("forwards details into sendMessage when provided", () => {
		const pi = fakePi();
		const inj = createInjector(pi);
		inj.steer("<advisory …blocker…>", { fullNote: "untruncated" });
		assert.deepEqual(pi.sent[0]!.message, {
			customType: "advisory",
			content: "<advisory …blocker…>",
			display: true,
			details: { fullNote: "untruncated" },
		});
	});

	it("steer goes through sendMessage as an advisory custom message with triggerTurn", () => {
		const pi = fakePi();
		const inj = createInjector(pi);
		inj.steer("<advisory …blocker…>");
		assert.deepEqual(pi.sent, [
			{
				message: { customType: "advisory", content: "<advisory …blocker…>", display: true },
				options: { deliverAs: "steer", triggerTurn: true },
			},
		]);
	});
});
