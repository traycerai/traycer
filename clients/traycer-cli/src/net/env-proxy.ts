import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Route the CLI's outbound HTTP through the machine's configured proxy.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the process
 * was STARTED with `NODE_USE_ENV_PROXY=1` - the option is read during bootstrap,
 * so setting the variable from inside the process is too late (measured on Node
 * 24: an in-process assignment still resolved the origin directly). The CLI
 * ships as a single executable, so there is no launcher to pass that flag from;
 * installing undici's `EnvHttpProxyAgent` as the global dispatcher is what makes
 * the same environment variables work.
 *
 * This is not a nicety. On a managed workstation where only the browser's proxy
 * is configured, every Node-side request fails at once - the CLI could not reach
 * the release registry (`E_REGISTRY_UNAVAILABLE`) and the host could not reach
 * the sign-in service, so it rejected its own local GUI for the entire session
 * while Electron's update check succeeded a few feet away (traycer#858).
 *
 * `EnvHttpProxyAgent` implements the semantics of those variables - notably the
 * per-host `NO_PROXY` exclusion list - but it reads them from `process.env`
 * unless each one is passed explicitly. Passing them keeps the injected `env`
 * the single source of truth, so the test seam exercises the same values the
 * agent will actually route on rather than whatever the runner happens to
 * export.
 */
const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

/** First non-blank value among `names`, or `""` for "not configured". */
function readEnv(
  env: Readonly<Partial<Record<string, string>>>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value.length > 0) return value;
  }
  return "";
}

/**
 * Installs the env-driven proxy dispatcher when the environment asks for one.
 *
 * Returns the variable that triggered it, or `null` when no proxy is
 * configured - in which case the default dispatcher is deliberately left
 * untouched, so the overwhelmingly common no-proxy path keeps Node's own
 * connection pooling and defaults rather than an equivalent-but-different agent.
 */
export function installEnvProxyDispatcher(
  env: Readonly<Partial<Record<string, string>>>,
): string | null {
  const configured = PROXY_ENV_VARS.find(
    (name) => (env[name] ?? "").trim().length > 0,
  );
  if (configured === undefined) return null;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      // Lowercase-first, matching the precedence undici applies when it reads
      // these itself, so naming them changes only WHERE they are read from.
      httpProxy: readEnv(env, ["http_proxy", "HTTP_PROXY"]),
      httpsProxy: readEnv(env, ["https_proxy", "HTTPS_PROXY"]),
      noProxy: readEnv(env, ["no_proxy", "NO_PROXY"]),
    }),
  );
  return configured;
}
