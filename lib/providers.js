/**
 * Provider resolution for the preflight check.
 *
 * Like `policy.js`, this module has no imports and no I/O, so `node --test`
 * exercises it directly. `bin/preflight.js` supplies the file reads and the
 * network call.
 */

/** Read a custom provider's base URL out of a Prime Agent `models.json` object. */
export function resolveBaseUrl(modelsConfig, provider) {
	const entry = modelsConfig?.providers?.[provider];
	return typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined;
}

/** The OpenAI-compatible listing endpoint for a base URL. */
export function modelsEndpoint(baseUrl) {
	return `${String(baseUrl).replace(/\/+$/, "")}/models`;
}

/**
 * True when the URL points at this machine.
 *
 * A forwarded Spark port looks local but depends on a tunnel, so a local
 * endpoint is exactly the case worth checking before an unattended run.
 */
export function isLocalEndpoint(baseUrl) {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/** An explicit `--provider` wins, then `defaultProvider` from settings. */
export function resolveProvider(argv, settings) {
	const index = argv.indexOf("--provider");
	if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("-")) {
		return argv[index + 1];
	}
	return settings?.defaultProvider;
}

/**
 * Every configured provider that serves from this machine.
 *
 * Nothing is hardcoded. Whatever is registered and local gets checked, so a new
 * Spark port needs no change here.
 */
export function localProviders(modelsConfig) {
	return Object.entries(modelsConfig?.providers ?? {})
		.filter(([, entry]) => typeof entry?.baseUrl === "string" && isLocalEndpoint(entry.baseUrl))
		.map(([name, entry]) => ({ name, baseUrl: entry.baseUrl }));
}

/** Model ids from an OpenAI-compatible `/v1/models` response. */
export function parseModelIds(payload) {
	if (!Array.isArray(payload?.data)) return [];
	return payload.data.map((model) => model?.id).filter((id) => typeof id === "string");
}

/**
 * Providers that must answer before an unattended run may start.
 *
 * A named list wins. Otherwise only the provider the run will actually use is
 * required, so an unrelated endpoint that happens to be down does not block it.
 */
export function requiredProviders(named, runProvider) {
	const list = String(named ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (list.length > 0) return list;
	return runProvider ? [runProvider] : [];
}
