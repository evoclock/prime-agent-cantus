/**
 * Is a human actually there to answer a prompt?
 *
 * These exist because of a measured surprise: `ctx.hasUI` was true in a
 * `--print` run, where nobody is watching. Trusting it alone would turn a
 * denial into a prompt with no one to answer it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide, humanPresent } from "../lib/policy.js";

describe("humanPresent", () => {
	it("says no when the launcher declares the run unattended", () => {
		// The strongest signal: the launcher knows, so it overrides the rest.
		assert.equal(humanPresent({ hasUI: true, isTTY: true, env: { CANTUS_UNATTENDED: "1" } }), false);
	});

	it("says no when stdin is not a terminal, whatever the harness reports", () => {
		// The measured case: hasUI true in --print.
		assert.equal(humanPresent({ hasUI: true, isTTY: false, env: {} }), false);
	});

	it("says no when the harness reports no UI", () => {
		assert.equal(humanPresent({ hasUI: false, isTTY: true, env: {} }), false);
	});

	it("says yes only when nothing objects", () => {
		assert.equal(humanPresent({ hasUI: true, isTTY: true, env: {} }), true);
	});

	it("defaults to no when nothing is known", () => {
		assert.equal(humanPresent(), false);
	});

	it("treats any value other than exactly 1 as not a declaration", () => {
		// A stray empty or "0" must not silently re-enable prompting.
		assert.equal(humanPresent({ hasUI: true, isTTY: true, env: { CANTUS_UNATTENDED: "0" } }), true);
		assert.equal(humanPresent({ hasUI: true, isTTY: true, env: { CANTUS_UNATTENDED: "" } }), true);
	});
});

describe("the verdict that follows", () => {
	const risky = { toolName: "bash", input: { command: "git reset --hard" } };

	it("denies with the reason when no human can answer", () => {
		const verdict = decide({ ...risky, hasUI: humanPresent({ hasUI: true, isTTY: false, env: {} }) });
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /discards uncommitted work/);
		assert.match(verdict.reason, /no human is present/);
	});

	it("prompts only when one can", () => {
		const verdict = decide({ ...risky, hasUI: humanPresent({ hasUI: true, isTTY: true, env: {} }) });
		assert.equal(verdict.action, "prompt");
	});
});
