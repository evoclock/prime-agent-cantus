/**
 * Precision: fire on danger, stay quiet on ordinary work.
 *
 * A gate that interrupts ordinary work gets switched off, and then it protects
 * nothing. Each case here pins a rule to a dangerous *act* rather than to a
 * *capability* — a module imported, a file opened — which on its own says
 * nothing about intent.
 *
 * Deletion is the exception and stays blunt on purpose. See the deletion suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, decide, deletionAllowedUnattended } from "../lib/policy.js";

const fires = (tool, input) => classify(tool, input) !== undefined;

describe("spawning a process", () => {
	it("stays quiet when the spawned command is ordinary", () => {
		// Searching a codebase via subprocess is routine.
		const code = 'import subprocess\nsubprocess.run(["grep", "-rn", "ValueError", "."])';
		assert.equal(fires("ipython", { code }), false);
	});

	it("stays quiet on the import alone", () => {
		assert.equal(fires("ipython", { code: "import subprocess\nimport os" }), false);
	});

	it("fires when the spawned command is dangerous", () => {
		const code = 'import subprocess\nsubprocess.run(["rm", "-rf", "build"])';
		assert.match(classify("ipython", { code }), /removes a directory/);
	});

	it("fires on a spawned push", () => {
		const code = 'subprocess.check_call(["git", "push", "--force"])';
		assert.match(classify("ipython", { code }), /shared history/);
	});

	it("still fires on os.system, which is a shell by definition", () => {
		assert.ok(fires("ipython", { code: 'os.system("ls")' }));
	});
});

describe("writing a file", () => {
	it("stays quiet writing an ordinary file", () => {
		// Writing a file is how an agent does its job.
		assert.equal(fires("ipython", { code: 'open("README.md", "w").write("# calc")' }), false);
		assert.equal(fires("ipython", { code: 'Path("notes.md").write_text("hello")' }), false);
	});

	it("fires writing to a protected path, whichever route is used", () => {
		assert.match(classify("ipython", { code: 'open(".env", "w").write("x")' }), /protected path/);
		assert.match(classify("bash", { command: 'echo x >> .env' }), /protected path/);
	});
});

describe("discussing a command rather than running it", () => {
	it("stays quiet on an echoed install", () => {
		// Reporting how one would install is not installing.
		const command = 'echo "you would run: pip install pytest"';
		assert.equal(fires("bash", { command }), false);
	});

	it("stays quiet on a commented command", () => {
		assert.equal(fires("bash", { command: "# pip install pytest\npytest --version" }), false);
	});

	it("stays quiet on a printed instruction", () => {
		assert.equal(fires("ipython", { code: 'print("run: pip install pytest")' }), false);
	});

	it("still fires on the real thing", () => {
		assert.match(classify("bash", { command: "pip install pytest" }), /without sfw/);
	});

	it("is not fooled by a comment marker inside a quoted string", () => {
		// `#` inside a path or a string must not blank the rest of the line.
		assert.ok(fires("bash", { command: "git push origin refs/heads/main#1" }));
	});
});

describe("removing a directory", () => {
	// Deliberately blunt. Removing a directory unsupervised leaves nothing to
	// inspect afterwards, so there is no exemption for a target that looks
	// routine.

	it("fires however routine the target looks", () => {
		for (const command of ["rm -rf build", "rm -r ./dist", "rmdir empty", "rm -rf node_modules"]) {
			assert.match(classify("bash", { command }), /removes a directory/, command);
		}
	});

	it("fires from Python too", () => {
		assert.match(classify("ipython", { code: 'shutil.rmtree("build")' }), /removes a directory/);
		assert.match(classify("ipython", { code: 'os.rmdir("build")' }), /removes a directory/);
	});

	it("names the reversible alternative rather than only refusing", () => {
		// An agent told no with no way forward will keep trying.
		assert.match(classify("bash", { command: "rm -rf build" }), /deprecated\/|to_deprecate\//);
	});

	it("stays quiet moving something aside instead", () => {
		assert.equal(fires("bash", { command: "mv build deprecated/" }), false);
	});

	it("is refused outright when unattended, not merely unapproved", () => {
		const verdict = decide({ toolName: "bash", input: { command: "rm -rf build" }, hasUI: false, env: {} });
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /Unattended runs never remove directories/);
		assert.match(verdict.reason, /CANTUS_ALLOW_DELETE=1/, "the refusal says how to change it");
	});

	it("still prompts rather than refuses when a human is there", () => {
		const verdict = decide({ toolName: "bash", input: { command: "rm -rf build" }, hasUI: true, env: {} });
		assert.equal(verdict.action, "prompt");
	});
});

describe("the deletion opt-in", () => {
	it("is off unless set to exactly 1", () => {
		assert.equal(deletionAllowedUnattended({}), false);
		assert.equal(deletionAllowedUnattended({ CANTUS_ALLOW_DELETE: "" }), false);
		assert.equal(deletionAllowedUnattended({ CANTUS_ALLOW_DELETE: "0" }), false);
		assert.equal(deletionAllowedUnattended({ CANTUS_ALLOW_DELETE: "true" }), false);
		assert.equal(deletionAllowedUnattended({ CANTUS_ALLOW_DELETE: "1" }), true);
	});

	it("changes the refusal to an ordinary block when opted in", () => {
		const verdict = decide({
			toolName: "bash",
			input: { command: "rm -rf build" },
			hasUI: false,
			env: { CANTUS_ALLOW_DELETE: "1" },
		});
		// Still blocked: opting in removes the special refusal, not the review.
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /no human is present/);
	});
});
