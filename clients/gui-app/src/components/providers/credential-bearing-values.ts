import type { ProviderMcpServerTransportWrite } from "@traycer/protocol/host/provider-native-schemas";

/** `http:` / `https:`, alone or as a `+` scheme's transport (`git+https:`). */
const HTTP_PROTOCOL = /^(?:[a-z0-9.-]+\+)?https?:$/;

/**
 * Whether a value is a URL carrying credentials in its userinfo
 * (`https://alice:token@host/mcp`, `postgres://user:pass@db/app`). A password
 * counts on any scheme. A user name alone counts on http(s), `git+https`
 * included, where a token is commonly passed as the user name
 * (`https://<token>@github.com/org/repo`), but not elsewhere:
 * `ssh://git@host/repo` or `postgres://app@db` names an account and carries no
 * secret. Text that is not a URL carries none by this rule.
 *
 * The one userinfo rule for every value a surface would send to a host that
 * takes no credentials (`hostTakesCredentials`): a URL like this is a
 * credential however it was typed, so it is refused like a key would be.
 */
export function urlCarriesCredentials(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.password.length > 0) return true;
  return parsed.username.length > 0 && HTTP_PROTOCOL.test(parsed.protocol);
}

/**
 * Mirrors the host's sandbox env-name rule
 * (`traycer-host/src/domain/sandbox/sandbox-credential-refusal.ts`): a host
 * that takes no credentials stores no variable whose NAME looks like one, so
 * the client refuses it before the send rather than after the host's refusal.
 * Keep the two patterns identical.
 */
const CREDENTIAL_SHAPED_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT)/i;

/** Whether an environment variable's name looks like a credential's. */
export function isCredentialShapedEnvName(name: string): boolean {
  return CREDENTIAL_SHAPED_ENV_NAME.test(name);
}

/**
 * Why an MCP server definition cannot be sent to a host that takes no
 * credentials, or `null`. Mirrors the host's own refusal for `nativeMutate`
 * MCP `add` / `update` on a sandbox, plus the client's userinfo rule:
 *  - `credential-env-name` - a stdio `env` NAME that looks like a
 *    credential's ({@link isCredentialShapedEnvName}, the host's rule);
 *  - `secret-auth`         - header or env auth on an http/sse server, which
 *    the host refuses whatever the values;
 *  - `url-sign-in`         - a URL carrying a sign-in: the remote URL, the
 *    OAuth resource, the stdio command or an argument
 *    (`mcp-remote https://alice:token@host/mcp`), or a stdio env value.
 * An OAuth server's client id and a plain stdio env variable are not
 * credentials.
 */
export type McpCredentialReason =
  | "credential-env-name"
  | "secret-auth"
  | "url-sign-in";

export function mcpTransportCredentialReason(
  transport: ProviderMcpServerTransportWrite,
): McpCredentialReason | null {
  if (transport.type === "stdio") {
    const env = transport.env ?? [];
    if (env.some((entry) => isCredentialShapedEnvName(entry.name))) {
      return "credential-env-name";
    }
    const signIn =
      urlCarriesCredentials(transport.command) ||
      transport.args.some(urlCarriesCredentials) ||
      env.some((entry) => urlCarriesCredentials(entry.value));
    return signIn ? "url-sign-in" : null;
  }
  if (transport.auth !== null) {
    switch (transport.auth.type) {
      case "header":
      case "env":
        return "secret-auth";
      case "oauth": {
        const resource = transport.auth.oauthResource;
        if (typeof resource === "string" && urlCarriesCredentials(resource)) {
          return "url-sign-in";
        }
        break;
      }
    }
  }
  return urlCarriesCredentials(transport.url) ? "url-sign-in" : null;
}
