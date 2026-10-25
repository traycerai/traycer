import type {
  EnvironmentConfigurationMcpServerPutRequestV11,
  EnvironmentMcpServerCredentialV11,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentMcpServer } from "@/hooks/environment/team/use-mcp-servers";

/** What the Add or Edit dialog holds while the person types. */
export interface McpServerForm {
  readonly name: string;
  readonly transport: "http" | "stdio";
  readonly url: string;
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly auth: "none" | "secret";
  /** Whether the sign-in was changed: an edit that leaves it keeps it. */
  readonly authTouched: boolean;
  /** A picked secret's id, or `new` for a value typed here. */
  readonly secretChoice: string;
  readonly secretValue: string;
  /** The variable a command server would read its secret from. */
  readonly variable: string;
}

export function initialMcpServerForm(
  server: EnvironmentMcpServer | null,
): McpServerForm {
  if (server === null)
    return {
      name: "",
      transport: "http",
      url: "",
      command: "",
      args: "",
      auth: "none",
      authTouched: false,
      secretChoice: "new",
      secretValue: "",
      variable: "",
    };
  return {
    name: server.name,
    transport: server.transport,
    url: server.url ?? "",
    command: server.command ?? "",
    args: server.args.join("\n"),
    auth: server.credential.kind === "none" ? "none" : "secret",
    authTouched: false,
    secretChoice: server.credential.secretId ?? "new",
    secretValue: "",
    variable: "",
  };
}

/** The host a remote server's address names, or null for no address. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The hosts a secret is sent to, once each, its destinations' ports dropped. */
function secretHosts(secret: EnvironmentSecret): readonly string[] {
  const hosts = secret.destinations.map(
    (destination) => destination.split(":")[0]?.toLowerCase() ?? "",
  );
  return [...new Set(hosts.filter((host) => host.length > 0))];
}

/** The secrets a server at `url` can be bound to: live, brokered, sent there. */
export function pickableSecrets(
  secrets: readonly EnvironmentSecret[],
  url: string,
): readonly EnvironmentSecret[] {
  const host = urlHost(url);
  if (host === null) return [];
  return secrets.filter(
    (secret) =>
      !secret.revoked &&
      secret.state === "live" &&
      secret.mode === "brokered" &&
      secretHosts(secret).includes(host),
  );
}

/**
 * The secret a refused save named: the one picked in the dialog, else the one
 * the server already holds. Null when neither is on the secrets list.
 */
export function refusedSecret(
  form: McpServerForm,
  server: EnvironmentMcpServer | null,
  secrets: readonly EnvironmentSecret[],
): { readonly name: string; readonly hosts: readonly string[] } | null {
  const id =
    form.authTouched && form.secretChoice !== "new"
      ? form.secretChoice
      : (server?.credential.secretId ?? null);
  const secret = secrets.find((candidate) => candidate.secretId === id);
  return secret === undefined
    ? null
    : { name: secret.name, hosts: secretHosts(secret) };
}

/** A command server is refused a secret: the broker cannot bind one. */
export function stdioSecretAsked(form: McpServerForm): boolean {
  return form.transport === "stdio" && form.auth === "secret";
}

/**
 * The credential a save sends, or null while a typed value is still missing.
 * An edit that leaves the sign-in keeps it; a picked secret needs `put@1.1`.
 */
export function mcpServerCredential(
  form: McpServerForm,
  editing: boolean,
  canPick: boolean,
): EnvironmentMcpServerCredentialV11 | null {
  if (editing && !form.authTouched) return { kind: "unchanged" };
  if (form.auth === "none" || form.transport === "stdio")
    return { kind: "none" };
  if (canPick && form.secretChoice !== "new")
    return { kind: "secret", secretId: form.secretChoice };
  return form.secretValue.length === 0
    ? null
    : { kind: "pat", pat: form.secretValue };
}

export function mcpServerReady(
  form: McpServerForm,
  credential: EnvironmentMcpServerCredentialV11 | null,
): boolean {
  if (form.name.trim().length === 0 || credential === null) return false;
  if (stdioSecretAsked(form)) return false;
  return form.transport === "http"
    ? urlHost(form.url) !== null
    : form.command.trim().length > 0;
}

/**
 * The put a save sends. An edit keeps the server's variables, tool toggles
 * and the providers it is off for; a create starts every provider's.
 */
export function mcpServerPutRequest(
  form: McpServerForm,
  server: EnvironmentMcpServer | null,
  environmentId: string,
  credential: EnvironmentMcpServerCredentialV11,
): EnvironmentConfigurationMcpServerPutRequestV11 {
  const remote = form.transport === "http";
  return {
    environmentId,
    serverId: server === null ? null : server.serverId,
    name: form.name.trim(),
    transport: form.transport,
    url: remote ? form.url.trim() : null,
    command: remote ? null : form.command.trim(),
    args: remote
      ? []
      : form.args
          .split("\n")
          .map((arg) => arg.trim())
          .filter((arg) => arg.length > 0),
    env: server === null ? [] : [...server.env],
    toolToggles: server?.item?.toolToggles ?? {},
    offFor: server?.item?.offFor ?? [],
    credential,
  };
}
