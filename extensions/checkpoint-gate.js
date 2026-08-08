/**
 * The cantus checkpoint gate.
 *
 * Supervised mode prompts before a reviewable action. Unattended mode denies it
 * and states why. `ctx.hasUI` selects the branch, so the gate needs no mode
 * setting of its own.
 *
 * One tracker lives for the session, so a command deferred across two calls —
 * written to a script here, run there — is still recognised.
 *
 * Set `CANTUS_LOG` to a path to append one JSON line per decision, for auditing
 * a session or measuring how often the gate fires. Off unless asked for.
 */

import { appendFileSync } from "node:fs";

import { createTracker, decide, humanPresent } from "../lib/policy.js";
import { screen } from "../lib/redact.js";

/** Shorten a command for a prompt without hiding what it does. */
function preview(input) {
	const text = String(input.command ?? input.code ?? input.path ?? "");
	const firstLines = text.split("\n").slice(0, 6).join("\n");
	return firstLines.length > 400 ? `${firstLines.slice(0, 400)}…` : firstLines;
}

/** Append a decision record. Logging must never break a session. */
function log(record) {
	const path = process.env.CANTUS_LOG;
	if (!path) return;
	try {
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
	} catch {
		// A full disk or an unwritable path is not worth failing a run over.
	}
}

export default function (pi) {
	const tracker = createTracker();

	pi.on("tool_call", async (event, ctx) => {
		// Resolved rather than taken from ctx.hasUI alone: that was observed
		// true in a --print run, where a prompt has nobody to answer it.
		const canAsk = humanPresent({
			hasUI: ctx.hasUI,
			env: process.env,
			isTTY: process.stdin.isTTY,
		});

		const verdict = decide({
			toolName: event.toolName,
			input: event.input,
			hasUI: canAsk,
			tracker,
			env: process.env,
		});

		const record = {
			tool: event.toolName,
			hasUI: Boolean(ctx.hasUI),
			canAsk,
			action: verdict.action,
			reason: verdict.reason,
			command: preview(event.input),
		};

		if (verdict.action === "allow") {
			log(record);
			return undefined;
		}

		if (verdict.action === "block") {
			log(record);
			return { block: true, reason: `cantus: ${verdict.reason}` };
		}

		const choice = await ctx.ui.select(
			`cantus checkpoint — ${verdict.reason}\n\n  ${preview(event.input)}\n\nAllow this action?`,
			["No", "Yes"],
		);

		log({ ...record, answer: choice === "Yes" ? "allowed" : "declined" });

		if (choice !== "Yes") {
			return { block: true, reason: "cantus: declined at the checkpoint" };
		}

		return undefined;
	});

	// Inspect what comes back, not only what goes out. Blocking a write to a
	// credentials file while letting the read through is backwards: the read is
	// what puts the secret into a prompt, and from there into whatever model is
	// serving — which is not always a local one.
	//
	// Set CANTUS_NO_SCREEN=1 to turn this off for a session.
	pi.on("tool_result", async (event) => {
		if (process.env.CANTUS_NO_SCREEN === "1") return undefined;

		let touched = false;
		const hidden = new Set();
		const redacted = new Set();
		const injections = new Set();

		const content = event.content.map((part) => {
			// Images and other non-text parts pass through untouched.
			if (part.type !== "text" || typeof part.text !== "string") return part;

			const result = screen(part.text);
			if (!result.changed) return part;

			touched = true;
			for (const name of result.hidden) hidden.add(name);
			for (const name of result.redacted) redacted.add(name);
			for (const name of result.injections) injections.add(name);
			return { ...part, text: result.text };
		});

		if (!touched) return undefined;

		log({
			tool: event.toolName,
			action: "screened",
			hidden: [...hidden],
			redacted: [...redacted],
			injections: [...injections],
		});

		return { content };
	});
}
