import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Route outbound HTTP through the machine proxy. Do not bypass for registry downloads. */
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

/** Installs the env-driven proxy dispatcher when the environment asks for one. Returns the variable that triggered it, or `null` when no proxy is configured - in which case the default dispatcher is deliberately left untouched, so the overwhelmingly common no-proxy path keeps Node's own connection pooling and defaults rather than an equivalent-but-different agent. */
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
