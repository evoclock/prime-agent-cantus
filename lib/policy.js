/**
 * Decision logic for the cantus checkpoint gate.
 *
 * This module has no imports and no I/O. `node --test` can therefore exercise
 * it with no runner, no build step and no installed dependency.
 *
 * The gate really blocks. A `block` verdict stops the tool call before it runs;
 * the model receives the reason instead of a result. It is enforcement, not a
 * warning.
 *
 * It is not containment. Three gaps are known and deliberate:
 *   1. `prime-agent` without `-e`, or with `--no-extensions`, never loads it.
 *   2. Matching is textual, so obfuscated code defeats it.
 *   3. Inline RLM child sessions get no extension runner, so their tool calls
 *      are not seen. See the P0 audit, Gap A.
 *
 * Treat it as the first gate, not the last. The containment boundary stays
 * outside the harness: git hooks, filesystem permissions and container mounts.
 */

/**
 * Where an agent may put something instead of deleting it.
 *
 * Refusing a deletion without an alternative leaves an agent stuck, so the
 * reason names this one. Moving a directory aside is reversible; a human can
 * delete it later, on purpose, having seen it.
 */
export const DEPRECATE_DIRS = ["deprecated/", "to_deprecate/"];

const DEPRECATE_INSTEAD = `move it to ${DEPRECATE_DIRS[0]} or ${DEPRECATE_DIRS[1]} instead, which is reversible`;

/** Shell commands that need a human decision before they run. */
export const REVIEW_BASH = [
	{ pattern: /\bgit\s+(reset|clean|stash)\b/, reason: "discards uncommitted work" },
	{ pattern: /\bgit\s+checkout\s+--/, reason: "discards local changes" },
	{ pattern: /\bgit\s+(push|merge|rebase)\b/, reason: "changes shared history" },
	{ pattern: /\brm\s+-[a-zA-Z]*r/, reason: `removes a directory; ${DEPRECATE_INSTEAD}` },
	{ pattern: /\brm\s+-[a-zA-Z]*f/, reason: "forced delete" },
	{ pattern: /\brmdir\b/, reason: `removes a directory; ${DEPRECATE_INSTEAD}` },
	{ pattern: /\bsudo\b/, reason: "elevates privileges" },
	{ pattern: /\b(chmod|chown)\b[^\n]*\b777\b/, reason: "world-writable permissions" },
	{ pattern: /\bcurl\b[^|\n]*\|\s*(ba|z)?sh\b/, reason: "pipes a remote script to a shell" },
];

/**
 * Paths that the gate protects from the edit tool.
 *
 * `.prime/agent/settings.json` is here for a specific reason. A global
 * `rlmMaxDepth` outranks the launcher's `RLM_MAX_DEPTH`, so an edit to that
 * file would let the agent raise its own recursion limit.
 */
export const PROTECTED_PATHS = [
	".git/",
	".env",
	"node_modules/",
	"id_rsa",
	"auth.json",
	".prime/agent/settings.json",
];

/** Package managers whose install must run under Socket Firewall. */
const INSTALL = /\b(npm|pnpm|yarn|pip|pip3|uv|pipx|cargo)\s+(install|add)\b/;

/**
 * Strip what a shell or Python would not execute.
 *
 * A command named in a comment, or echoed as advice, is being discussed rather
 * than run. Inspecting it would make describing an install indistinguishable
 * from performing one.
 */
function executableText(text) {
	return String(text)
		.split("\n")
		.map((line) => line.replace(/(^|\s)#.*$/, "$1"))
		.join("\n")
		.replace(/\becho\s+(["'])[\s\S]*?\1/g, " ")
		.replace(/\bprint\s*\(\s*(["'])[\s\S]*?\1\s*\)/g, " ");
}

/**
 * The command a Python spawn is about to run.
 *
 * `subprocess` is how an agent runs a build or a grep, so flagging the module
 * would make ordinary work reviewable. What gets inspected is the command
 * inside the call.
 */
function spawnedCommands(code) {
	const found = [];
	const call = /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(([\s\S]*?)\)/g;
	for (const match of String(code).matchAll(call)) {
		found.push(match[1].replace(/["'[\],]/g, " "));
	}
	return found.join("\n");
}

/**
 * Python that reaches the shell or the filesystem from an IPython cell.
 *
 * These flag what is being done, not which module was imported. Writing a file
 * is how an agent does its job; the reviewable act is writing to a protected
 * path, checked separately by `protectedWrite`.
 *
 * Removing a directory is always here, whatever it points at and however
 * routine it looks. A rule that exempts a "safe" target is a rule that can be
 * argued into exempting the wrong one.
 */
const PYTHON_WRITES = [
	{ pattern: /\bos\.system\b/, reason: "spawns a shell from Python" },
	{ pattern: /\bshutil\.rmtree\b|\bos\.removedirs\b|\bos\.rmdir\b|\.rmdir\s*\(/, reason: `removes a directory; ${DEPRECATE_INSTEAD}` },
];

/**
 * Actions that no approval may authorise, in either mode.
 *
 * ADR-0004 withholds `main.merge`, `main.write` and `task.mark_done` from an
 * agent-only session. An entry here is refused even when a human is present,
 * because the correct path is a pull request, not a prompt.
 *
 * The list starts empty on purpose. Add an entry when you decide that a human
 * at the keyboard is still not the right approver for it.
 */
export const NEVER = [];

/** Split a shell command into the segments that a shell would run separately. */
function segments(command) {
	return String(command).split(/&&|\|\||;|\n/);
}

/** True when a package install does not lead with `sfw`. */
export function isUnwrappedInstall(command) {
	return segments(command).some((segment) => INSTALL.test(segment) && !/^\s*sfw\s+/.test(segment));
}

/** Match a command against a rule list. Returns the first reason, or undefined. */
function firstMatch(rules, text) {
	return rules.find((rule) => rule.pattern.test(text))?.reason;
}

/** Pull the shell fragments out of an IPython cell. */
function shellFromCell(code) {
	const cell = String(code);
	const lines = cell.split("\n");
	if (/^\s*%%bash\b/.test(cell)) return lines.slice(1).join("\n");
	return lines
		.filter((line) => /^\s*!/.test(line))
		.map((line) => line.replace(/^\s*!/, ""))
		.join("\n");
}

// --- Where a call writes ------------------------------------------------
//
// Shared by the protected-path check below and the cross-call tracker further
// down: both need to know which file a call puts content into.

/** Python writing to a path: `Path("f").write_text(...)`, `open("f", "w")`. */
const PY_WRITE_TARGET = /(?:Path\(\s*["']([^"']+)["']\s*\)\s*\.write_(?:text|bytes)|open\(\s*["']([^"']+)["']\s*,\s*["'][wax])/g;

/** Commands that take their destination as a plain argument. */
const WRITE_ARG = /\b(?:sed\s+-i(?:\s+\S+)?|cp|mv|install|truncate\s+-s\s*\d+)\s+(?:\S+\s+)*?(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))\s*(?:$|[;&|])/g;

/** The protected path this text writes to, if any. */
function protectedWrite(text) {
	// A path is protected wherever it is written, not only through the edit
	// tool: a model asked to change a file may reach for Python's open().
	for (const pattern of [REDIRECT_TARGET, PY_WRITE_TARGET, WRITE_ARG]) {
		pattern.lastIndex = 0;
		for (const match of String(text).matchAll(pattern)) {
			const target = firstGroup(match);
			if (!target) continue;
			const hit = PROTECTED_PATHS.find((protectedPath) => target.includes(protectedPath));
			if (hit) return `writes to the protected path ${hit}`;
		}
	}
	return undefined;
}

/** Classify one tool call. Returns a reason when the call needs review. */
export function classify(toolName, input = {}) {
	if (toolName === "bash") {
		const command = String(input.command ?? "");
		const runnable = executableText(command);
		if (isUnwrappedInstall(runnable)) return "installs a package without sfw";
		return firstMatch(REVIEW_BASH, runnable) ?? protectedWrite(command);
	}

	if (toolName === "edit") {
		const path = String(input.path ?? "");
		const hit = PROTECTED_PATHS.find((protectedPath) => path.includes(protectedPath));
		return hit ? `edits the protected path ${hit}` : undefined;
	}

	if (toolName === "ipython") {
		const code = String(input.code ?? "");
		const shell = executableText(shellFromCell(code));
		if (shell) {
			if (isUnwrappedInstall(shell)) return "installs a package without sfw";
			const shellReason = firstMatch(REVIEW_BASH, shell);
			if (shellReason) return shellReason;
		}

		// What a spawn is about to run counts as a shell command, so `rm -rf`
		// through subprocess is caught while an ordinary grep is not.
		const spawned = spawnedCommands(code);
		if (spawned) {
			if (isUnwrappedInstall(spawned)) return "installs a package without sfw";
			const spawnedReason = firstMatch(REVIEW_BASH, spawned);
			if (spawnedReason) return spawnedReason;
		}

		return firstMatch(PYTHON_WRITES, executableText(code)) ?? protectedWrite(code);
	}

	return undefined;
}

/** True when the call is refused in both modes. */
export function isNever(toolName, input = {}) {
	const text = String(input.command ?? input.code ?? input.path ?? "");
	return NEVER.some((rule) => rule.pattern.test(text));
}

// --- Cross-call tracking -------------------------------------------------
//
// A gate that inspects one call at a time can be walked around in two moves:
// write a script in the first call, run it in the second; or define a git alias
// in the first, invoke it in the second. Each call on its own looks harmless.
//
// The extension outlives the calls, so it can remember. These helpers spot the
// first move and mark the name it created, so the second move is recognised.
// This is still textual, and a name laundered through a variable still escapes.
// It closes the deferral, not obfuscation in general.

/** `> file`, `>> file`, or `tee file`. */
const REDIRECT_TARGET = /(?:>>?|\btee\b(?:\s+-a)?)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&>]+))/g;

/**
 * `sh f`, `bash f`, `source f`, `. f`, `./f`.
 *
 * The lookbehind is load-bearing. Without it `\bsh\b` matches the tail of a
 * filename — in `echo x > cleanup.sh\nsh cleanup.sh` the first match came from
 * `cleanup.sh`, capturing the word `sh` rather than the script, and the deferred
 * command would run unseen.
 *
 * All are global, and every match is checked rather than only the first, so an
 * earlier innocent-looking invocation cannot mask a later one.
 */
const EXECUTES = [
	/(?<![\w./-])(?:ba|z|k)?sh\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g,
	/(?<![\w./-])source\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g,
	/(?:^|[;&|]\s*)\.\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/gm,
	/(?:^|[;&|]\s*)(\.\/[^\s;|&]+)/gm,
];

/** `git config alias.NAME 'body'`, with the body captured. */
const GIT_ALIAS = /\bgit\s+config\s+(?:--\w+\s+)*alias\.([\w-]+)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** First non-empty capture group. */
const firstGroup = (match) => match?.slice(1).find((group) => group !== undefined);

/** Strip a leading `./` so `./s.sh` and `s.sh` are the same name. */
const normalise = (name) => String(name).replace(/^\.\//, "");

/**
 * Session memory for the gate.
 *
 * `observe` is called on every tool call, whatever the verdict, so the tracker
 * sees the setup move even when it was allowed. `check` reports whether this
 * call cashes in something an earlier call created.
 */
/**
 * Variables holding a protected path.
 *
 * A check that reads only literal strings sees nothing once the path is built
 * into a variable. `env_path = os.path.join(d, ".env")` names it;
 * `open(env_path, "a")` uses it. Remembering the name connects the two.
 */
const PATH_ASSIGNMENT = /\b([A-Za-z_]\w*)\s*=\s*([^\n]+)/g;

/**
 * A write whose destination is a bare identifier rather than a literal.
 *
 * Three forms, because a model uses all of them: `open(name, "w")`,
 * `name.write_text(...)`, and `Path(name).write_text(...)` where the identifier
 * sits inside the constructor.
 */
const WRITE_VIA_NAME = /\bopen\s*\(\s*([A-Za-z_]\w*)\s*,\s*["'][wax]|\bPath\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\.\s*write_(?:text|bytes)|\b([A-Za-z_]\w*)\s*\.\s*write_(?:text|bytes)\s*\(/g;

export function createTracker() {
	const taintedFiles = new Set();
	const taintedAliases = new Map();
	const taintedNames = new Map();

	/** Text of the call, whichever tool it came from. */
	const textOf = (toolName, input) => {
		if (toolName === "ipython") {
			const code = String(input.code ?? "");
			return `${shellFromCell(code)}\n${code}`;
		}
		return String(input.command ?? input.code ?? "");
	};

	return {
		/** Record what this call sets up for later. */
		observe(toolName, input = {}) {
			const text = textOf(toolName, input);
			const danger = firstMatch(REVIEW_BASH, text) ?? (isUnwrappedInstall(text) ? "an unwrapped install" : undefined);

			// A file that receives dangerous text becomes dangerous to run.
			if (danger) {
				for (const match of text.matchAll(REDIRECT_TARGET)) {
					const target = firstGroup(match);
					if (target) taintedFiles.add(normalise(target));
				}
				for (const match of text.matchAll(PY_WRITE_TARGET)) {
					const target = firstGroup(match);
					if (target) taintedFiles.add(normalise(target));
				}
			}

			// An alias is dangerous if its body is.
			const alias = GIT_ALIAS.exec(text);
			if (alias) {
				const body = alias.slice(2).find((group) => group !== undefined) ?? "";
				const reason = firstMatch(REVIEW_BASH, `git ${body}`);
				if (reason) taintedAliases.set(alias[1], reason);
			}

			// A name that was handed a protected path carries it forward, and
			// a name built from another tainted name carries it too.
			PATH_ASSIGNMENT.lastIndex = 0;
			for (const match of text.matchAll(PATH_ASSIGNMENT)) {
				const [, name, value] = match;
				const literal = PROTECTED_PATHS.find((protectedPath) => value.includes(protectedPath));
				if (literal) {
					taintedNames.set(name, literal);
					continue;
				}
				for (const [known, protectedPath] of taintedNames) {
					if (new RegExp(String.raw`\b${known}\b`).test(value)) {
						taintedNames.set(name, protectedPath);
						break;
					}
				}
			}
		},

		/** Reason this call cashes in an earlier one, or undefined. */
		check(toolName, input = {}) {
			const text = textOf(toolName, input);

			for (const pattern of EXECUTES) {
				pattern.lastIndex = 0;
				for (const match of text.matchAll(pattern)) {
					const target = firstGroup(match);
					if (target && taintedFiles.has(normalise(target))) {
						return `runs ${normalise(target)}, which an earlier call filled with a reviewable command`;
					}
				}
			}

			for (const [name, reason] of taintedAliases) {
				if (new RegExp(String.raw`\bgit\s+${name}\b`).test(text)) {
					return `runs the git alias "${name}", defined earlier as a command that ${reason}`;
				}
			}

			WRITE_VIA_NAME.lastIndex = 0;
			for (const match of text.matchAll(WRITE_VIA_NAME)) {
				const name = firstGroup(match);
				const protectedPath = name && taintedNames.get(name);
				if (protectedPath) {
					return `writes to the protected path ${protectedPath}, held in "${name}"`;
				}
			}

			return undefined;
		},

		/** Test and diagnostic access. */
		state() {
			return { files: [...taintedFiles], aliases: [...taintedAliases.keys()] };
		},
	};
}

/**
 * Whether a human can actually answer a prompt.
 *
 * `ctx.hasUI` alone is not enough. It was observed true in a `--print` run,
 * where nobody is watching, which would have turned a denial into a prompt
 * answered by nothing. Three signals, and the most conservative wins:
 *
 *   1. `CANTUS_UNATTENDED=1` — set by the unattended launcher, which knows.
 *   2. stdin is not a terminal — nobody can type an answer.
 *   3. `ctx.hasUI` — the harness's own view, used only to say "no".
 *
 * Deciding this wrongly in the safe direction costs a denial. Deciding it
 * wrongly the other way lets an unattended run approve itself.
 */
export function humanPresent({ hasUI, env = {}, isTTY } = {}) {
	if (env.CANTUS_UNATTENDED === "1") return false;
	if (isTTY === false) return false;
	return Boolean(hasUI);
}

/**
 * Decide what the gate does with one tool call.
 *
 * Pass a `tracker` from `createTracker()` to catch a deferred command. Without
 * one the decision is made on this call alone.
 *
 * `hasUI` here means "a human can answer", as resolved by `humanPresent`.
 *
 * @returns {{action: "allow"|"prompt"|"block", reason?: string}}
 */
/** True when a reason describes removing a directory. */
function isDirectoryRemoval(reason) {
	return typeof reason === "string" && reason.startsWith("removes a directory");
}

/**
 * Whether an unattended run may delete a directory.
 *
 * Off by default, deliberately. Unattended means no one is there to notice, and
 * a deletion is the one mistake with nothing left to inspect afterwards. The
 * gate names `deprecated/` in its refusal, so an agent has somewhere to put the
 * thing rather than being stuck.
 *
 * Anyone who disagrees can turn it on. That is their call to make explicitly,
 * on their own machine, and it should never be the default anyone inherits.
 */
export function deletionAllowedUnattended(env = {}) {
	return env.CANTUS_ALLOW_DELETE === "1";
}

export function decide({ toolName, input = {}, hasUI, tracker, env = {} }) {
	if (isNever(toolName, input)) {
		return { action: "block", reason: "refused by policy; open a pull request instead" };
	}

	// Observe first. A model routinely puts the setup and the payoff in one
	// cell — defining a git alias and invoking it in the same block — and
	// checking before observing would miss exactly that. Observing first is
	// safe because `classify` runs ahead of `check`: a call whose own text is
	// reviewable is caught on its own merits, not on the taint it just created.
	tracker?.observe(toolName, input);

	const reason = classify(toolName, input) ?? tracker?.check(toolName, input);

	if (!reason) return { action: "allow" };

	if (!hasUI) {
		// A deletion is refused rather than merely blocked-for-lack-of-approval.
		// The distinction matters in the message: there is no approval to seek,
		// so the agent is told what to do instead.
		if (isDirectoryRemoval(reason) && !deletionAllowedUnattended(env)) {
			return {
				action: "block",
				reason: `${reason}. Unattended runs never remove directories; set CANTUS_ALLOW_DELETE=1 to change that.`,
			};
		}
		return { action: "block", reason: `${reason}; no human is present to approve it` };
	}

	return { action: "prompt", reason };
}
