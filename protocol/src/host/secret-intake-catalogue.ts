/**
 * THE SECRET INTAKE CATALOGUE: the data a secret's add form reads, in one
 * place for every reader. The broker's intake, the dashboard's add dialog and
 * the desktop's Secrets page all read these tables, so a kind, a protocol or
 * a not-brokered line cannot mean one thing in one of them and another in the
 * next. The internal broker's modules re-export the names from here; the zod
 * policy schemas, the verifier derivation and the cloud tables stay with the
 * broker.
 *
 * Data only: no schema, no I/O.
 */

/** Names accepted by secret intake, shared with forms and move choices. */
export const SANDBOX_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Every protocol a route can carry. */
export const SANDBOX_ROUTE_PROTOCOLS = [
  "https",
  "http",
  "h2c",
  "h3",
  "postgres",
  "mysql",
  "redis",
  "mongo",
  "clickhouse",
  "tds",
  "oracle",
  "cassandra",
  "snowflake",
  "neon-ws",
  "ssh",
  "sigv4",
  "azure-shared-key",
  "gcp-sa",
  "azure-sp",
  "mtls",
  "kafka",
  "amqp",
  "mqtt",
  "smtp",
  "imap",
  "pop3",
  "rdp",
] as const;
export type SandboxRouteProtocol = (typeof SANDBOX_ROUTE_PROTOCOLS)[number];

/**
 * Connection-string dialects: one generated string per dialect, never one
 * string for two drivers.
 */
export const SANDBOX_CONNECTION_DIALECTS = [
  "libpq-url",
  "prisma",
  "jdbc",
  "mysql-url",
  "mysql-cli",
  "redis-url",
  "mongodb-uri",
  "clickhouse-url",
  "mssql-url",
  "odbc",
  "snowflake-host",
  "amqp-url",
  "mqtt-url",
  "kafka-bootstrap",
  "smtp-url",
  "imap-url",
  "pop3-url",
  "login",
  "placeholder",
  "host",
  "port",
] as const;
export type SandboxConnectionDialect =
  (typeof SANDBOX_CONNECTION_DIALECTS)[number];

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * What the person is storing, chosen first on the add form; each kind admits
 * the protocols in {@link SANDBOX_SECRET_KIND_PROTOCOLS}. `github`, `harness`
 * and `mcp_credential` are made by their own flows, never by the form.
 * `provider` is one model provider's API key.
 */
export const SANDBOX_SECRET_KINDS = [
  "api_key",
  "database",
  "ssh",
  "aws",
  "azure_storage",
  "azure_sp",
  "gcp_sa",
  "client_certificate",
  "broker",
  "mail",
  "rdp",
  "github",
  "harness",
  "mcp_credential",
  "provider",
] as const;
export type SandboxSecretKind = (typeof SANDBOX_SECRET_KINDS)[number];

export const SANDBOX_SECRET_KIND_PROTOCOLS: Readonly<
  Record<SandboxSecretKind, readonly SandboxRouteProtocol[]>
> = {
  api_key: ["https", "http", "h2c", "h3"],
  database: [
    "postgres",
    "neon-ws",
    "mysql",
    "redis",
    "mongo",
    "clickhouse",
    "tds",
    "oracle",
    "cassandra",
    "snowflake",
  ],
  ssh: ["ssh"],
  aws: ["sigv4"],
  azure_storage: ["azure-shared-key"],
  azure_sp: ["azure-sp"],
  gcp_sa: ["gcp-sa"],
  client_certificate: ["mtls"],
  broker: ["kafka", "amqp", "mqtt"],
  mail: ["smtp", "imap", "pop3"],
  rdp: ["rdp"],
  github: ["https"],
  harness: ["https"],
  mcp_credential: ["https", "http"],
  provider: ["https"],
};

/** Kinds the add form offers: every kind but the three flow-made ones. */
export const SANDBOX_SECRET_FORM_KINDS = [
  "api_key",
  "database",
  "ssh",
  "aws",
  "azure_storage",
  "azure_sp",
  "gcp_sa",
  "client_certificate",
  "broker",
  "mail",
  "rdp",
  "provider",
] as const satisfies readonly SandboxSecretKind[];
export type SandboxSecretFormKind = (typeof SANDBOX_SECRET_FORM_KINDS)[number];

export const SANDBOX_SECRET_MODES = ["brokered", "exposed"] as const;
export type SandboxSecretMode = (typeof SANDBOX_SECRET_MODES)[number];

export const SANDBOX_EXPORT_POLICIES = [
  "none",
  "presigned_url",
  "short_lived_credentials",
] as const;
export type SandboxExportPolicy = (typeof SANDBOX_EXPORT_POLICIES)[number];

/** Where a key may appear in an HTTP request. */
export const SANDBOX_SECRET_SWAP_SITES = ["header", "query", "body"] as const;
export type SandboxSecretSwapSite = (typeof SANDBOX_SECRET_SWAP_SITES)[number];

// ---------------------------------------------------------------------------
// Not brokered in v1
// ---------------------------------------------------------------------------

/**
 * THE PROTOCOL FAMILIES NOT BROKERED IN V1 (user decisions
 * 2026-10-12 for RDP and 2026-10-13 for the message brokers, mail, Oracle and
 * Cassandra). The broker's intake refuses a secret on any of these protocols,
 * in either mode, with `protocol_not_brokered` and the row's line, and every
 * add form greys them with the same line.
 *
 * `oracle` and `cassandra` are protocols of the `database` kind that are not
 * database engines: the kind stays live, these two protocols inside it are
 * refused.
 */
export const SANDBOX_UNBROKERED_FAMILIES = [
  "kafka",
  "amqp",
  "mqtt",
  "mail",
  "rdp",
  "oracle",
  "cassandra",
] as const;
export type SandboxUnbrokeredFamily =
  (typeof SANDBOX_UNBROKERED_FAMILIES)[number];

export interface SandboxUnbrokeredRow {
  /** The route protocols the family covers. */
  readonly protocols: readonly SandboxRouteProtocol[];
  /** The one line intake and every picker show. */
  readonly copy: string;
}

export const SANDBOX_UNBROKERED: Readonly<
  Record<SandboxUnbrokeredFamily, SandboxUnbrokeredRow>
> = {
  kafka: { protocols: ["kafka"], copy: "Kafka is not brokered in v1." },
  amqp: { protocols: ["amqp"], copy: "AMQP is not brokered in v1." },
  mqtt: { protocols: ["mqtt"], copy: "MQTT is not brokered in v1." },
  mail: {
    protocols: ["smtp", "imap", "pop3"],
    copy: "Mail (SMTP, IMAP and POP3) is not brokered in v1.",
  },
  rdp: { protocols: ["rdp"], copy: "RDP is not brokered in v1." },
  oracle: { protocols: ["oracle"], copy: "Oracle is not brokered in v1." },
  cassandra: {
    protocols: ["cassandra"],
    copy: "Cassandra is not brokered in v1.",
  },
};

/** The row that refuses a route protocol, or null when the protocol is brokered. */
export function sandboxUnbrokeredRowFor(
  protocol: SandboxRouteProtocol,
): SandboxUnbrokeredRow | null {
  for (const family of SANDBOX_UNBROKERED_FAMILIES) {
    const row = SANDBOX_UNBROKERED[family];
    if (row.protocols.includes(protocol)) {
      return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Database engines
// ---------------------------------------------------------------------------

/**
 * The database engines, spelled as their route protocol. `neon-ws` is
 * PostgreSQL over WebSocket. Oracle and Cassandra are route protocols of the
 * `database` kind but not engines: they are not brokered in v1.
 */
export const SANDBOX_DATABASE_ENGINES = [
  "postgres",
  "neon-ws",
  "mysql",
  "redis",
  "mongo",
  "clickhouse",
  "tds",
  "snowflake",
] as const;
export type SandboxDatabaseEngine = (typeof SANDBOX_DATABASE_ENGINES)[number];

/**
 * The port the guest dials on the route's own loopback address: the engine's
 * default, so a client that omits the port still reaches it.
 */
export const SANDBOX_DATABASE_DEFAULT_PORT: Readonly<
  Record<SandboxDatabaseEngine, number>
> = {
  postgres: 5432,
  "neon-ws": 443,
  mysql: 3306,
  redis: 6379,
  mongo: 27017,
  clickhouse: 9440,
  tds: 1433,
  snowflake: 443,
};

const SCALAR_DIALECTS = ["login", "placeholder", "host", "port"] as const;

/**
 * The dialects a variable bound to each engine may name, the most common
 * first: intake refuses any other. The scalar parts (`login`, `placeholder`,
 * `host`, `port`) apply to every engine.
 */
export const SANDBOX_DATABASE_DIALECTS: Readonly<
  Record<SandboxDatabaseEngine, ReadonlyArray<SandboxConnectionDialect>>
> = {
  postgres: ["libpq-url", "prisma", "jdbc", ...SCALAR_DIALECTS],
  "neon-ws": ["libpq-url", "prisma", "jdbc", ...SCALAR_DIALECTS],
  mysql: ["mysql-url", "prisma", "mysql-cli", "jdbc", ...SCALAR_DIALECTS],
  redis: ["redis-url", ...SCALAR_DIALECTS],
  mongo: ["mongodb-uri", ...SCALAR_DIALECTS],
  clickhouse: ["clickhouse-url", ...SCALAR_DIALECTS],
  tds: ["mssql-url", "odbc", "jdbc", ...SCALAR_DIALECTS],
  snowflake: ["snowflake-host", ...SCALAR_DIALECTS],
};

/** The upstream mechanisms a route may enrol, per engine, strongest first. */
export const SANDBOX_DATABASE_UPSTREAM_MECHANISMS = {
  postgres: ["scram-sha-256-plus", "scram-sha-256", "md5"],
  // Neon's WebSocket endpoint asks for the password in the clear inside its
  // TLS (the driver's default `pipelineConnect: "password"` depends on it).
  "neon-ws": ["password", "scram-sha-256"],
  mysql: ["caching_sha2_password", "mysql_native_password"],
  redis: ["auth"],
  mongo: ["scram-sha-256", "scram-sha-1"],
  clickhouse: ["password"],
  tds: ["sql-server"],
  snowflake: ["password", "key-pair-jwt"],
} as const satisfies Record<SandboxDatabaseEngine, ReadonlyArray<string>>;

export type SandboxDatabaseUpstreamMechanism =
  (typeof SANDBOX_DATABASE_UPSTREAM_MECHANISMS)[SandboxDatabaseEngine][number];

/**
 * Gate T (the database page, "Gate T: revoke during COMMIT, measured"): of
 * 100 revokes that reached the worker during a `COMMIT`, how many landed
 * after the server had committed: the highest figure measured on any
 * machine. Null until the engine's run exists.
 */
export const SANDBOX_DATABASE_COMMITTED_AFTER_CUT: Readonly<
  Record<SandboxDatabaseEngine, number | null>
> = {
  postgres: 38,
  "neon-ws": 38,
  mysql: 41,
  redis: 41,
  mongo: 41,
  clickhouse: 20,
  tds: 34,
  snowflake: null,
};

/** The engine's name as the consent copy says it. */
const ENGINE_LABEL: Readonly<Record<SandboxDatabaseEngine, string>> = {
  postgres: "PostgreSQL",
  "neon-ws": "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  mongo: "MongoDB",
  clickhouse: "ClickHouse",
  tds: "SQL Server",
  snowflake: "Snowflake",
};

/**
 * The version of the plaintext-through-the-gateway disclosure the add forms
 * show today: the version of the consent lines below. A create that carries
 * the consent records this version with the acceptance.
 */
export const SANDBOX_PLAINTEXT_DISCLOSURE_VERSION = 1;

/**
 * The two lines a person confirms for a brokered database secret (the
 * database page, "Intake fields and consent copy"). The second carries the
 * engine's gate T figure once it is measured.
 */
export function sandboxDatabaseConsentCopy(
  engine: SandboxDatabaseEngine,
): readonly [string, string] {
  const measured = SANDBOX_DATABASE_COMMITTED_AFTER_CUT[engine];
  const residual =
    measured === null
      ? ""
      : ` In our tests, ${measured} of 100 revokes that arrived during a commit on ${ENGINE_LABEL[engine]} landed after the server had committed.`;
  return [
    "Queries you run from this sandbox, and the rows they return, pass through Traycer's gateway in plaintext. We do not store them.",
    `This login can do whatever you granted it on the server. Revoking here stops further traffic; it does not undo a statement the server already committed.${residual}`,
  ];
}

/** Whether a route protocol is one of the database engines. */
export function isSandboxDatabaseEngine(
  protocol: SandboxRouteProtocol,
): protocol is SandboxDatabaseEngine {
  return SANDBOX_DATABASE_ENGINES.some((engine) => engine === protocol);
}
