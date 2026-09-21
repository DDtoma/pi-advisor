import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModelSpec } from "../src/pi/model-caller.ts";

describe("parseModelSpec", () => {
	it("splits provider and model id", () => {
		assert.deepEqual(parseModelSpec("minimax-cn/MiniMax-M3"), {
			provider: "minimax-cn",
			modelId: "MiniMax-M3",
		});
	});

	it("parses a thinking suffix", () => {
		assert.deepEqual(parseModelSpec("anthropic/claude-sonnet:high"), {
			provider: "anthropic",
			modelId: "claude-sonnet",
			thinking: "high",
		});
	});

	it("accepts every pi ThinkingLevel plus off", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal(parseModelSpec(`p/m:${level}`).thinking, level);
		}
	});

	it("keeps a non-thinking colon suffix as part of the model id", () => {
		assert.deepEqual(parseModelSpec("p/model:fv2"), {
			provider: "p",
			modelId: "model:fv2",
		});
	});

	it("rejects specs without a provider slash", () => {
		assert.throws(() => parseModelSpec("noslash"), /model not found/);
	});
});
