import { describe, expect, it } from "vitest";

import { mergeHookPrompts } from "./hooks-runner";

describe("mergeHookPrompts", () => {
	it("returns an empty string when no hooks produced feedback", () => {
		expect(mergeHookPrompts([])).toBe("");
	});

	it("preserves a single hook result unchanged", () => {
		expect(mergeHookPrompts(["Fix the formatting error."])).toBe("Fix the formatting error.");
	});

	it("combines multiple hook results into one bounded prompt in order", () => {
		expect(mergeHookPrompts(["First result", "Second result"])).toBe(
			[
				"Multiple hook results were produced during the previous agent run. Address all of them:",
				'<hook-result index="1">\nFirst result\n</hook-result>',
				'<hook-result index="2">\nSecond result\n</hook-result>',
			].join("\n\n"),
		);
	});
});
