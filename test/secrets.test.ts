import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED, SecretScrubber } from "../src/advisor/secrets.ts";

describe("SecretScrubber", () => {
	it("redacts OpenAI keys", () => {
		const s = new SecretScrubber();
		const key = "sk-" + "a".repeat(40);
		const out = s.scrub(`export OPENAI_API_KEY=${key}`);
		assert.ok(!out.includes(key));
		assert.ok(out.includes(REDACTED));
	});

	it("redacts OpenAI project keys", () => {
		const s = new SecretScrubber();
		const key = "sk-proj-" + "Ab1_".repeat(10);
		assert.ok(!s.scrub(`key: ${key}`).includes(key));
	});

	it("redacts Anthropic keys", () => {
		const s = new SecretScrubber();
		const key = "sk-ant-" + "x".repeat(40);
		assert.ok(!s.scrub(key).includes(key));
	});

	it("redacts GitHub tokens", () => {
		const s = new SecretScrubber();
		for (const prefix of ["ghp_", "gho_", "github_pat_"]) {
			const tok = prefix + "T".repeat(30);
			assert.ok(!s.scrub(`token ${tok} end`).includes(tok), prefix);
		}
	});

	it("redacts AWS access key ids", () => {
		const s = new SecretScrubber();
		const key = "AKIA" + "Z".repeat(16);
		assert.ok(!s.scrub(`aws: ${key}`).includes(key));
	});

	it("redacts JWTs", () => {
		const s = new SecretScrubber();
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${"b".repeat(20)}.${"c".repeat(20)}`;
		assert.ok(!s.scrub(`Bearer ${jwt}`).includes(jwt));
	});

	it("redacts PEM private key blocks", () => {
		const s = new SecretScrubber();
		const pem =
			"-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
		const out = s.scrub(`before\n${pem}\nafter`);
		assert.ok(!out.includes("MIIEvwIBADANBgkqhkiG9w0BAQEFAASC"));
		assert.ok(out.includes("before") && out.includes("after"));
	});

	it("redacts generic api_key assignments (quoted)", () => {
		const s = new SecretScrubber();
		const out = s.scrub(`api_key = "supersecretvalue123"`);
		assert.ok(!out.includes("supersecretvalue123"));
	});

	it("redacts generic token assignments (bare)", () => {
		const s = new SecretScrubber();
		const out = s.scrub(`token: abcdefgh12345678zz`);
		assert.ok(!out.includes("abcdefgh12345678zz"));
	});

	it("leaves ordinary text untouched", () => {
		const s = new SecretScrubber();
		const text = "The quick brown fox jumps over the lazy dog. password is a noun.";
		assert.equal(s.scrub(text), text);
	});

	it("does not redact short assignment values", () => {
		const s = new SecretScrubber();
		const text = `password = "short"`;
		assert.equal(s.scrub(text), text);
	});

	it("cross-round: value collected in round 1 is redacted in different text in round 2", () => {
		const s = new SecretScrubber();
		const key = "sk-" + "q".repeat(40);
		s.scrub(`first mention ${key}`);
		const out2 = s.scrub(`different sentence, the raw ${key} appears bare`);
		assert.ok(!out2.includes(key));
		assert.ok(out2.includes(REDACTED));
	});

	it("literal pass covers values the regex would miss in new context", () => {
		const s = new SecretScrubber();
		const key = "AKIA" + "M".repeat(16);
		s.scrub(`creds: ${key}`);
		// Same value embedded with no word boundary context.
		const out = s.scrub(`prefix-${key}-suffix`);
		assert.ok(!out.includes(key));
	});

	it("reset() stops redacting previously collected values", () => {
		const s = new SecretScrubber();
		const key = "sk-" + "r".repeat(40);
		s.scrub(key);
		s.reset();
		assert.equal(s.collectedCount, 0);
		// The bare key no longer matches a regex context on its own? It does
		// (sk- pattern is context-free), so use an assignment-collected value.
		const s2 = new SecretScrubber();
		const v = "collectedvalue99xx";
		s2.scrub(`token: ${v}`); // collected via assignment regex
		s2.reset();
		const out = s2.scrub(`bare ${v} here`); // no assignment context now
		assert.equal(out, `bare ${v} here`);
	});

	it("evicts oldest collected values beyond 1024 (FIFO)", () => {
		const s = new SecretScrubber();
		for (let i = 0; i < 1100; i++) {
			s.scrub(`token: "value${String(i).padStart(6, "0")}abcdef"`);
		}
		assert.ok(s.collectedCount <= 1024);
	});
});
