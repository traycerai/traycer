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
 * Whether an MCP server definition carries a secret: an auth header's value,
 * a stdio env value, or credentials in one of its URLs - the remote URL, the
 * OAuth resource, or a URL passed as a stdio argument
 * (`mcp-remote https://alice:token@host/mcp`). An OAuth server's client id and
 * an env-auth server's variable NAME are not secrets.
 */
export function mcpTransportCarriesSecret(
  transport: ProviderMcpServerTransportWrite,
): boolean {
  if (transport.type === "stdio") {
    return (
      transport.env !== null ||
      urlCarriesCredentials(transport.command) ||
      transport.args.some(urlCarriesCredentials)
    );
  }
  if (urlCarriesCredentials(transport.url)) return true;
  if (transport.auth === null) return false;
  switch (transport.auth.type) {
    case "header":
      return true;
    case "oauth": {
      const resource = transport.auth.oauthResource;
      return typeof resource === "string" && urlCarriesCredentials(resource);
    }
    case "env":
      // The variable NAME the host reads its token from; a value here would be
      // the token itself.
      return transport.auth.value.length > 0;
  }
}
