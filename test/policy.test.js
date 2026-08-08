import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, decide, isUnwrappedInstall } from "../lib/policy.js";

describe("isUnwrappedInstall", () => {
	it("accepts an install that leads with sfw", () => {
		assert.equal(isUnwrappedInstall("sfw npm install left-pad"), false);
	});

	it("flags a bare install", () => {
		assert.equal(isUnwrappedInstall("npm install left-pad"), true);
		assert.equal(isUnwrappedInstall("uv add polars"), true);
	});

	it("flags an install hidden after a chained command", () => {
		assert.equal(isUnwrappedInstall("cd /tmp && pip install requests"), true);
	});

	it("ignores a command that is not an install", () => {
		assert.equal(isUnwrappedInstall("npm run test"), false);
	});
});

describe("classify", () => {
	it("flags commands that discard uncommitted work", () => {
		assert.match(classify("bash", { command: "git reset --hard" }), /discards uncommitted work/);
		assert.match(classify("bash", { command: "git clean -fd" }), /discards uncommitted work/);
	});

	it("flags commands that change shared history", () => {
		assert.match(classify("bash", { command: "git push origin main" }), /shared history/);
	});

	it("allows an ordinary command", () => {
		assert.equal(classify("bash", { command: "git status" }), undefined);
	});

	it("protects sensitive paths from the edit tool", () => {
		assert.match(classify("edit", { path: "project/.env" }), /protected path/);
		assert.equal(classify("edit", { path: "src/main.js" }), undefined);
	});

	it("reads shell escapes inside an ipython cell", () => {
		assert.match(classify("ipython", { code: "%%bash\nrm -rf build" }), /removes a directory/);
		assert.match(classify("ipython", { code: '!git push origin main' }), /shared history/);
	});

	it("flags a dangerous command run from python, not the module used to run it", () => {
		// See test/precision.test.js: flagging every spawn and every file write
		// interrupted a third of realistic tasks, so what matters is the act.
		assert.match(classify("ipython", { code: 'subprocess.run(["rm", "-rf", "x"])' }), /removes a directory/);
		assert.equal(classify("ipython", { code: "subprocess.run(['ls'])" }), undefined);
		assert.equal(classify("ipython", { code: 'Path("a").write_text("b")' }), undefined);
		assert.match(classify("ipython", { code: 'Path(".env").write_text("b")' }), /protected path/);
	});

	it("allows ipython that only reads", () => {
		assert.equal(classify("ipython", { code: "df = pd.read_csv('data.csv')" }), undefined);
	});
});

describe("decide", () => {
	const risky = { toolName: "bash", input: { command: "git reset --hard" } };

	it("blocks a reviewable action when no human is present", () => {
		const verdict = decide({ ...risky, hasUI: false });
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /no human is present/);
	});

	it("prompts for the same action when a human is present", () => {
		assert.equal(decide({ ...risky, hasUI: true }).action, "prompt");
	});

	it("allows a safe action in both modes", () => {
		const safe = { toolName: "bash", input: { command: "ls -la" } };
		assert.equal(decide({ ...safe, hasUI: false }).action, "allow");
		assert.equal(decide({ ...safe, hasUI: true }).action, "allow");
	});
});
