#!/usr/bin/env node
/**
 * Check that local model endpoints answer before an unattended run starts.
 *
 * Nothing is hardcoded. Every provider in `models.json` that serves from this
 * machine is probed, and each endpoint reports the models it currently serves.
 * A new port needs no change here, only a provider entry.
 *
 * A dead Ollama daemon or a dropped tunnel otherwise consumes the autonomous
 * budget on failing requests. This costs one HTTP call per endpoint.
 *
 * Usage:
 *   preflight.js [--provider NAME] [...]   probe, then require the run provider
 *   preflight.js --list                    probe and report only, never fail
 *
 * Exit codes: 0 all required endpoints answered, 69 one did not.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	localProviders,
	modelsEndpoint,
	parseModelIds,
	requiredProviders,
	resolveProvider,
} from "../lib/providers.js";

const TIMEOUT_MS = Number(process.env.PA_PREFLIGHT_TIMEOUT_MS ?? 5000);

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Probe one endpoint's model listing. Never throws. */
async function probe({ name, baseUrl }) {
	const endpoint = modelsEndpoint(baseUrl);
	try {
		const response = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!response.ok) {
			return { name, baseUrl, ok: false, detail: `HTTP ${response.status}` };
		}
		const models = parseModelIds(await response.json().catch(() => undefined));
		return { name, baseUrl, ok: true, models };
	} catch (error) {
		return { name, baseUrl, ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Ask an endpoint to actually generate.
 *
 * A listing proves a process is bound to the port. It does not prove the
 * backend can answer. The budget is deliberately generous: a reasoning model
 * spends most of it thinking, and a small budget reports a healthy model as
 * broken. Observed: a 35B reasoning model used about 150 tokens to say one word.
 */
async function probeDeep(result) {
	if (!result.ok || result.models.length === 0) return result;
	const model = result.models[0];
	const endpoint = `${result.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "Reply with exactly the word READY and nothing else." }],
				max_tokens: Number(process.env.PA_DEEP_MAX_TOKENS ?? 512),
				stream: false,
			}),
			signal: AbortSignal.timeout(Number(process.env.PA_DEEP_TIMEOUT_MS ?? 180000)),
		});
		if (!response.ok) {
			return { ...result, deep: { ok: false, detail: `HTTP ${response.status}` } };
		}
		const body = await response.json().catch(() => undefined);
		const choice = body?.choices?.[0];
		const text = choice?.message?.content ?? choice?.message?.reasoning_content;
		if (typeof text !== "string" || text.trim() === "") {
			return { ...result, deep: { ok: false, detail: "generated no text; the backend may be unhealthy" } };
		}
		return { ...result, deep: { ok: true, tokens: body?.usage?.completion_tokens } };
	} catch (error) {
		return { ...result, deep: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
	}
}

function report(result) {
	if (!result.ok) {
		console.error(`  ✖ ${result.name}  ${result.baseUrl}  ${result.detail}`);
		return;
	}
	const served = result.models.length > 0 ? result.models.join(", ") : "no models listed";
	if (!result.deep) {
		console.error(`  ✔ ${result.name}  ${result.baseUrl}  ${served}`);
		return;
	}
	const mark = result.deep.ok ? "✔" : "✖";
	const detail = result.deep.ok ? `generated (${result.deep.tokens ?? "?"} tokens)` : `listed but ${result.deep.detail}`;
	console.error(`  ${mark} ${result.name}  ${result.baseUrl}  ${served}  — ${detail}`);
}

async function main() {
	const argv = process.argv.slice(2);
	const listOnly = argv.includes("--list") || argv.includes("--deep");

	const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent");
	const settings = readJson(join(agentDir, "settings.json"));
	const models = readJson(join(agentDir, "models.json"));

	const providers = localProviders(models);
	if (providers.length === 0) {
		if (listOnly) console.error("No local providers are registered in models.json.");
		return 0;
	}

	let results = await Promise.all(providers.map(probe));

	// Serialised deliberately: a local host answers one model at a time, so
	// probing them in parallel would misreport.
	if (argv.includes("--deep")) {
		const deep = [];
		for (const result of results) deep.push(await probeDeep(result));
		results = deep;
	}

	if (listOnly || results.some((result) => !result.ok || result.deep?.ok === false)) {
		console.error("Local model endpoints:");
		for (const result of results) report(result);
	}
	if (listOnly) return 0;

	const required = requiredProviders(process.env.PA_PREFLIGHT_PROVIDERS, resolveProvider(argv, settings));
	const down = results.filter((result) => !result.ok && required.includes(result.name));
	if (down.length === 0) return 0;

	for (const result of down) {
		console.error(`pa-auto: required provider "${result.name}" is unreachable (${result.detail})`);
	}
	console.error("pa-auto: start the server or restore the tunnel, then retry.");
	console.error("pa-auto: set PA_PREFLIGHT=0 to skip, or PA_PREFLIGHT_PROVIDERS to change what is required.");
	return 69;
}

process.exit(await main());
