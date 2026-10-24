import {
  SANDBOX_DATABASE_DIALECTS,
  SANDBOX_ROUTE_PROTOCOLS,
  SANDBOX_SECRET_KINDS,
  SANDBOX_SECRET_KIND_PROTOCOLS,
  isSandboxDatabaseEngine,
  sandboxUnbrokeredRowFor,
  type SandboxConnectionDialect,
  type SandboxRouteProtocol,
  type SandboxSecretFormKind,
  type SandboxSecretKind,
  type SandboxSecretMode,
} from "@traycer/protocol/host/secret-intake-catalogue";

/**
 * What Settings ▸ Personal ▸ Secrets says about each kind, protocol and mode.
 * The kinds, their protocols and the not-brokered lines come from the secret
 * intake catalogue in `@traycer/protocol`, the table the broker's intake and
 * the dashboard read too, never from here.
 */

export const SECRET_KIND_LABEL: Readonly<Record<SandboxSecretKind, string>> = {
  api_key: "API key or token",
  database: "Database login",
  ssh: "SSH",
  aws: "AWS access key",
  azure_storage: "Azure Storage account key",
  azure_sp: "Azure service principal",
  gcp_sa: "Google Cloud service account",
  client_certificate: "Client certificate",
  broker: "Message broker login",
  mail: "Mail login",
  rdp: "Remote desktop login",
  github: "GitHub",
  harness: "Coding CLI",
  mcp_credential: "MCP server credential",
  provider: "Model provider API key",
};

/** A stored secret's kind as the list names it; an unknown kind by its own name. */
export function secretKindLabel(kind: string): string {
  const known = SANDBOX_SECRET_KINDS.find((entry) => entry === kind);
  return known === undefined ? kind : SECRET_KIND_LABEL[known];
}

/** One line under each kind in the add dialog's first step. */
const SECRET_KIND_HINT: Readonly<Record<SandboxSecretFormKind, string>> = {
  api_key: "A key or token for an HTTPS service",
  database: "A database login",
  ssh: "A host reached with your Traycer SSH key",
  aws: "Signs requests to the AWS services you name",
  azure_storage: "Signs requests to one storage account",
  azure_sp: "Tenant, client and secret of a service principal",
  gcp_sa: "A service-account key file",
  client_certificate: "A certificate and key presented to the destination",
  broker: "Kafka, AMQP or MQTT",
  mail: "SMTP, IMAP or POP3",
  rdp: "A Windows host over RDP",
  provider: "One model provider's API key",
};

/**
 * The kinds whose form lives in the app. SSH, the cloud and certificate
 * kinds have no row: secrets are values and logins. The protocol catalogue
 * is unchanged.
 */
export const DESKTOP_SECRET_KINDS = [
  "api_key",
  "provider",
  "database",
] as const satisfies readonly SandboxSecretFormKind[];
export type DesktopSecretKind = (typeof DESKTOP_SECRET_KINDS)[number];

export function isDesktopSecretKind(
  kind: SandboxSecretFormKind,
): kind is DesktopSecretKind {
  return DESKTOP_SECRET_KINDS.some((desktop) => desktop === kind);
}

export const SECRET_PROTOCOL_LABEL: Readonly<
  Record<SandboxRouteProtocol, string>
> = {
  https: "HTTPS",
  http: "HTTP (unencrypted)",
  h2c: "HTTP/2 without TLS",
  h3: "HTTP/3",
  postgres: "PostgreSQL",
  "neon-ws": "PostgreSQL over WebSocket (Neon serverless driver)",
  mysql: "MySQL",
  redis: "Redis",
  mongo: "MongoDB",
  clickhouse: "ClickHouse",
  tds: "SQL Server",
  oracle: "Oracle",
  cassandra: "Cassandra",
  snowflake: "Snowflake",
  ssh: "SSH",
  sigv4: "AWS Signature Version 4",
  "azure-shared-key": "Azure Shared Key",
  "gcp-sa": "Google service account",
  "azure-sp": "Azure service principal",
  mtls: "Mutual TLS",
  kafka: "Kafka",
  amqp: "AMQP",
  mqtt: "MQTT",
  smtp: "SMTP",
  imap: "IMAP",
  pop3: "POP3",
  rdp: "RDP",
};

/** A stored secret's protocol as the list names it; an unknown one by its own name. */
export function secretProtocolLabel(protocol: string): string {
  const known = SANDBOX_ROUTE_PROTOCOLS.find((entry) => entry === protocol);
  return known === undefined ? protocol : SECRET_PROTOCOL_LABEL[known];
}

export const SECRET_MODE_LABEL: Readonly<Record<SandboxSecretMode, string>> = {
  brokered: "Brokered",
  exposed: "Exposed",
};

/** What each mode means on a sandbox, in the one line the dialog states it in. */
export const SECRET_MODE_CONSEQUENCE: Readonly<
  Record<SandboxSecretMode, string>
> = {
  brokered: "On a sandbox, agents can use it and never read it.",
  exposed:
    "On a sandbox, any process can read it, and revoking it does not stop a copy already made.",
};

export const SECRET_DATABASE_LOGIN_ADVICE =
  "Use a dedicated login with the least privilege the work needs: a sandbox gets exactly this login's rights.";

/**
 * Why a kind cannot be stored, or `null` for a kind the picker opens. A kind
 * is unsupported when every protocol it admits is in the catalogue's
 * not-brokered table; it is then shown greyed with that table's own lines.
 */
export function secretKindUnsupportedReason(
  kind: SandboxSecretFormKind,
): string | null {
  const copies: string[] = [];
  for (const protocol of SANDBOX_SECRET_KIND_PROTOCOLS[kind]) {
    const row = sandboxUnbrokeredRowFor(protocol);
    if (row === null) return null;
    if (!copies.includes(row.copy)) copies.push(row.copy);
  }
  return copies.length === 0 ? null : copies.join(" ");
}

/** The not-brokered table's line for a protocol, or `null` when it can be chosen. */
export function secretProtocolUnsupportedReason(
  protocol: SandboxRouteProtocol,
): string | null {
  return sandboxUnbrokeredRowFor(protocol)?.copy ?? null;
}

/** The protocols of a kind the form lets the person choose. */
export function secretKindProtocols(
  kind: SandboxSecretFormKind,
): readonly SandboxRouteProtocol[] {
  return SANDBOX_SECRET_KIND_PROTOCOLS[kind].filter(
    (protocol) => secretProtocolUnsupportedReason(protocol) === null,
  );
}

/**
 * The line under a kind in the picker. A database's names the engines that
 * can be chosen, so an engine the table stops brokering leaves it.
 */
export function secretKindHint(kind: SandboxSecretFormKind): string {
  if (kind !== "database") return SECRET_KIND_HINT[kind];
  const engines = [
    ...new Set(
      secretKindProtocols(kind).map(
        (protocol) => SECRET_PROTOCOL_LABEL[protocol],
      ),
    ),
  ];
  return engines.length === 0 ? SECRET_KIND_HINT[kind] : engines.join(", ");
}

/**
 * The formats a variable bound to this protocol may carry, the most common
 * first; empty for a protocol that takes no variables.
 */
export function secretVariableDialects(
  protocol: SandboxRouteProtocol,
): readonly SandboxConnectionDialect[] {
  return isSandboxDatabaseEngine(protocol)
    ? SANDBOX_DATABASE_DIALECTS[protocol]
    : [];
}

export const SECRET_DIALECT_LABEL: Readonly<
  Record<SandboxConnectionDialect, string>
> = {
  "libpq-url": "PostgreSQL URL (psql, libpq, most drivers)",
  prisma: "Prisma URL",
  jdbc: "JDBC URL",
  "mysql-url": "MySQL URL",
  "mysql-cli": "mysql client options",
  "redis-url": "Redis URL",
  "mongodb-uri": "MongoDB URI",
  "clickhouse-url": "ClickHouse URL",
  "mssql-url": "SQL Server URL",
  odbc: "ODBC connection string",
  "snowflake-host": "Snowflake host",
  "amqp-url": "AMQP URL",
  "mqtt-url": "MQTT URL",
  "kafka-bootstrap": "Kafka bootstrap servers",
  "smtp-url": "SMTP URL",
  "imap-url": "IMAP URL",
  "pop3-url": "POP3 URL",
  login: "Login only",
  placeholder: "Password only",
  host: "Host only",
  port: "Port only",
};

/** The variable name the form proposes for a protocol's first variable. */
export function secretDefaultVariableName(
  protocol: SandboxRouteProtocol,
): string {
  return isSandboxDatabaseEngine(protocol) ? "DATABASE_URL" : "";
}
