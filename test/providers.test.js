import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isLocalEndpoint,
	localProviders,
	modelsEndpoint,
	parseModelIds,
	requiredProviders,
	resolveBaseUrl,
	resolveProvider,
} from "../lib/providers.js";

const CONFIG = {
	providers: {
		"local-a": { baseUrl: "http://127.0.0.1:11111/v1" },
		"local-b": { baseUrl: "http://127.0.0.1:22222/v1" },
		"no-url": { api: "openai-completions" },
		remote: { baseUrl: "https://api.example.com/v1" },
	},
};

describe("resolveBaseUrl", () => {
	it("finds a configured provider", () => {
		assert.equal(resolveBaseUrl(CONFIG, "local-a"), "http://127.0.0.1:11111/v1");
	});

	it("returns undefined for a built-in provider", () => {
		assert.equal(resolveBaseUrl(CONFIG, "a-builtin-provider"), undefined);
	});

	it("returns undefined when the entry has no baseUrl", () => {
		assert.equal(resolveBaseUrl(CONFIG, "no-url"), undefined);
	});

	it("survives a missing or malformed config", () => {
		assert.equal(resolveBaseUrl(undefined, "local-a"), undefined);
		assert.equal(resolveBaseUrl({}, "local-a"), undefined);
	});
});

describe("modelsEndpoint", () => {
	it("appends the listing path", () => {
		assert.equal(modelsEndpoint("http://127.0.0.1:11111/v1"), "http://127.0.0.1:11111/v1/models");
	});

	it("does not double the separator", () => {
		assert.equal(modelsEndpoint("http://127.0.0.1:11111/v1/"), "http://127.0.0.1:11111/v1/models");
	});
});

describe("isLocalEndpoint", () => {
	it("recognises a forwarded port as local", () => {
		assert.equal(isLocalEndpoint("http://127.0.0.1:22222/v1"), true);
		assert.equal(isLocalEndpoint("http://localhost:33333/v1"), true);
	});

	it("rejects a remote host", () => {
		assert.equal(isLocalEndpoint("https://api.anthropic.com/v1"), false);
	});

	it("rejects a malformed URL", () => {
		assert.equal(isLocalEndpoint("not a url"), false);
	});
});

describe("resolveProvider", () => {
	const settings = { defaultProvider: "local-a" };

	it("prefers an explicit --provider", () => {
		assert.equal(resolveProvider(["--provider", "local-b", "task"], settings), "local-b");
	});

	it("falls back to the settings default", () => {
		assert.equal(resolveProvider(["task"], settings), "local-a");
	});

	it("ignores --provider with no value", () => {
		assert.equal(resolveProvider(["--provider", "--autonomous"], settings), "local-a");
	});

	it("returns undefined when nothing is configured", () => {
		assert.equal(resolveProvider([], undefined), undefined);
	});
});

describe("localProviders", () => {
	it("finds every locally served provider, whatever it is", () => {
		assert.deepEqual(
			localProviders(CONFIG).map((entry) => entry.name),
			["local-a", "local-b"],
		);
	});

	it("skips remote endpoints and entries with no baseUrl", () => {
		const names = localProviders(CONFIG).map((entry) => entry.name);
		assert.equal(names.includes("remote"), false);
		assert.equal(names.includes("no-url"), false);
	});

	it("survives a missing config", () => {
		assert.deepEqual(localProviders(undefined), []);
		assert.deepEqual(localProviders({}), []);
	});
});

describe("parseModelIds", () => {
	it("reads an OpenAI-compatible listing", () => {
		const payload = { data: [{ id: "model-one" }, { id: "model-two" }] };
		assert.deepEqual(parseModelIds(payload), ["model-one", "model-two"]);
	});

	it("drops malformed entries", () => {
		assert.deepEqual(parseModelIds({ data: [{ id: "a" }, {}, { id: 7 }] }), ["a"]);
	});

	it("survives a missing or non-list payload", () => {
		assert.deepEqual(parseModelIds(undefined), []);
		assert.deepEqual(parseModelIds({ data: "nope" }), []);
	});
});

describe("requiredProviders", () => {
	it("prefers an explicit list", () => {
		assert.deepEqual(requiredProviders("local-a, local-b", "other"), ["local-a", "local-b"]);
	});

	it("falls back to the provider the run will use", () => {
		assert.deepEqual(requiredProviders(undefined, "local-a"), ["local-a"]);
		assert.deepEqual(requiredProviders("", "local-a"), ["local-a"]);
	});

	it("requires nothing when no provider is resolved", () => {
		assert.deepEqual(requiredProviders(undefined, undefined), []);
	});
});
