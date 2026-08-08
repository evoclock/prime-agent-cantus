/**
 * Cross-call tracking: does the gate connect a setup move to its payoff?
 *
 * Each test plays a sequence of calls through one tracker, as a session would.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTracker, decide } from "../lib/policy.js";

/** Play calls in order; return the verdicts. */
function session(calls, { hasUI = false } = {}) {
	const tracker = createTracker();
	return calls.map(([toolName, input]) => decide({ toolName, input, hasUI, tracker }));
}

const bash = (command) => ["bash", { command }];
const ipy = (code) => ["ipython", { code }];

describe("write a script, then run it", () => {
	it("blocks the run, not just the write", () => {
		const [write, run] = session([
			bash("printf 'git reset --hard' > s.sh"),
			bash("sh s.sh"),
		]);
		assert.equal(write.action, "block", "the write itself is visible and caught");
		assert.equal(run.action, "block", "the run is caught by what the write left behind");
		assert.match(run.reason, /which an earlier call filled/);
	});

	it("catches ./script and bash script and source script", () => {
		for (const invocation of ["./s.sh", "bash s.sh", "source s.sh", ". s.sh"]) {
			const verdicts = session([bash("echo 'git clean -fd' > s.sh"), bash(invocation)]);
			assert.equal(verdicts[1].action, "block", `${invocation} should be blocked`);
		}
	});

	it("catches a python-written script", () => {
		const verdicts = session([
			ipy('Path("s.sh").write_text("git reset --hard")'),
			bash("sh s.sh"),
		]);
		assert.equal(verdicts[1].action, "block");
	});

	it("normalises ./name and name to the same file", () => {
		const verdicts = session([bash("echo 'sudo rm -rf /' > ./x.sh"), bash("sh x.sh")]);
		assert.equal(verdicts[1].action, "block");
	});

	it("leaves an innocent script alone", () => {
		const verdicts = session([bash("echo 'echo hello' > ok.sh"), bash("sh ok.sh")]);
		assert.equal(verdicts[0].action, "allow");
		assert.equal(verdicts[1].action, "allow", "no false positive on a harmless script");
	});
});

describe("define a git alias, then use it", () => {
	it("blocks the invocation", () => {
		const verdicts = session([
			bash("git config alias.z 'reset --hard'"),
			bash("git z"),
		]);
		assert.equal(verdicts[1].action, "block");
		assert.match(verdicts[1].reason, /alias "z"/);
	});

	it("leaves a harmless alias alone", () => {
		const verdicts = session([bash("git config alias.st 'status -sb'"), bash("git st")]);
		assert.equal(verdicts[1].action, "allow");
	});
});

describe("setup and payoff in a single call", () => {
	// A model routinely defines an alias and uses it in the same cell, so the
	// tracker must record before it checks.

	it("blocks an alias defined and invoked in the same call", () => {
		const [verdict] = session([bash("git config alias.nuke 'reset --hard'\ngit nuke")]);
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /alias "nuke"/);
	});

	it("blocks it inside one ipython cell, as a model actually writes it", () => {
		const [verdict] = session([
			ipy("%%bash\ngit config alias.nuke 'reset --hard'\necho 'running'\ngit nuke"),
		]);
		assert.equal(verdict.action, "block");
	});

	it("still leaves a harmless same-call alias alone", () => {
		const [verdict] = session([bash("git config alias.st 'status -sb'\ngit st")]);
		assert.equal(verdict.action, "allow");
	});
});

describe("deferral within and across calls", () => {
	it("does not mistake the tail of a filename for the shell", () => {
		// `\bsh\b` must not match the ".sh" ending a filename on an earlier
		// line, or the first match captures the word "sh" and the real
		// invocation goes unchecked.
		const [verdict] = session([ipy('%%bash\necho "git reset --hard HEAD" > cleanup.sh\nsh cleanup.sh\n')]);
		assert.equal(verdict.action, "block");
		assert.match(verdict.reason, /runs cleanup\.sh/);
	});

	it("checks every execution in a call, not only the first", () => {
		const [verdict] = session([bash("echo 'git push' > deploy.sh\nsh harmless.sh\nsh deploy.sh")]);
		assert.equal(verdict.action, "block");
	});

	it("follows a protected path held in a variable", () => {
		// A path built into a variable is invisible to a literal-string check.
		const verdicts = session([
			ipy('import os\nbase = "/tmp/x"'),
			ipy('env_path = os.path.join(base, ".env")'),
			ipy('with open(env_path, "a") as f:\n    f.write("DEBUG=true")'),
		]);
		assert.equal(verdicts[2].action, "block");
		assert.match(verdicts[2].reason, /protected path \.env, held in "env_path"/);
	});

	it("follows the path through a second variable", () => {
		const verdicts = session([
			ipy('secrets = ".env"'),
			ipy("target = secrets"),
			ipy('Path(target).write_text("x")'),
		]);
		assert.equal(verdicts[2].action, "block");
	});

	it("leaves an ordinary variable-held path alone", () => {
		const verdicts = session([
			ipy('notes = "NOTES.md"'),
			ipy('open(notes, "w").write("hello")'),
		]);
		assert.equal(verdicts[1].action, "allow");
	});
});

describe("tracker bookkeeping", () => {
	it("judges a call on its own text before any taint it created", () => {
		// The write is caught for what it says, not for what it left behind.
		const tracker = createTracker();
		const verdict = decide({ ...bashCall("printf 'git reset --hard' > s.sh"), hasUI: false, tracker });
		assert.match(verdict.reason, /discards uncommitted work/);
		assert.doesNotMatch(verdict.reason, /earlier call/);
	});

	it("records what it is tracking", () => {
		const tracker = createTracker();
		decide({ ...bashCall("echo 'git push' > deploy.sh"), hasUI: false, tracker });
		decide({ ...bashCall("git config alias.nuke 'clean -fdx'"), hasUI: false, tracker });
		assert.deepEqual(tracker.state().files, ["deploy.sh"]);
		assert.deepEqual(tracker.state().aliases, ["nuke"]);
	});

	it("works without a tracker, judging each call alone", () => {
		assert.equal(decide({ ...bashCall("sh s.sh"), hasUI: false }).action, "allow");
	});
});

function bashCall(command) {
	return { toolName: "bash", input: { command } };
}
