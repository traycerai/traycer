import { describe, expect, it } from "vitest";
import {
  SECRET_DIALECT_LABEL,
  secretDefaultVariableName,
  secretKindHint,
  secretKindLabel,
  secretKindProtocols,
  secretKindUnsupportedReason,
  secretProtocolLabel,
  secretProtocolUnsupportedReason,
  secretVariableDialects,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  initialSecretForm,
  nextVariableId,
  secretCreateRequest,
  secretFormHosts,
  secretFormNeedsConsent,
  secretFormPort,
  secretFormProblem,
  secretVerifyCandidateRequest,
  secretVerifyProblem,
  withSecretProtocol,
  type SecretFormState,
} from "@/lib/sandboxes/secret-intake-form";
import { secretVerifyLine } from "@/lib/sandboxes/secret-verify-copy";

/** A database form that passes `secretFormProblem`, brokered and consented. */
function validDatabaseForm(): SecretFormState {
  return {
    ...initialSecretForm("database"),
    name: "PROD_DB",
    hosts: "a.example.com, b.example.com",
    identity: "app",
    database: "orders",
    value: "s3cret-db-password",
    plaintextConsent: true,
  };
}

/** An API key form that passes `secretFormProblem`. */
function validApiKeyForm(): SecretFormState {
  return {
    ...initialSecretForm("api_key"),
    name: "STRIPE_KEY",
    hosts: "api.stripe.com",
    value: "sk_live_typed_value",
  };
}

describe("what the picker greys", () => {
  it("greys the message broker kind with the table's lines for all three protocols", () => {
    expect(secretKindUnsupportedReason("broker")).toBe(
      "Kafka is not brokered in v1. AMQP is not brokered in v1. MQTT is not brokered in v1.",
    );
  });

  it("greys the mail kind with the one mail line", () => {
    expect(secretKindUnsupportedReason("mail")).toBe(
      "Mail (SMTP, IMAP and POP3) is not brokered in v1.",
    );
  });

  it("greys the remote desktop kind", () => {
    expect(secretKindUnsupportedReason("rdp")).toBe(
      "RDP is not brokered in v1.",
    );
  });

  it("opens every other form kind", () => {
    for (const kind of [
      "api_key",
      "database",
      "ssh",
      "aws",
      "azure_storage",
      "azure_sp",
      "gcp_sa",
      "client_certificate",
      "provider",
    ] as const) {
      expect(secretKindUnsupportedReason(kind), kind).toBeNull();
    }
  });

  it("keeps the database kind live while refusing Oracle and Cassandra inside it", () => {
    expect(secretKindUnsupportedReason("database")).toBeNull();
    expect(secretProtocolUnsupportedReason("oracle")).toBe(
      "Oracle is not brokered in v1.",
    );
    expect(secretProtocolUnsupportedReason("cassandra")).toBe(
      "Cassandra is not brokered in v1.",
    );
    expect(secretProtocolUnsupportedReason("postgres")).toBeNull();
    const protocols = secretKindProtocols("database");
    expect(protocols).not.toContain("oracle");
    expect(protocols).not.toContain("cassandra");
    expect(protocols).toEqual([
      "postgres",
      "neon-ws",
      "mysql",
      "redis",
      "mongo",
      "clickhouse",
      "tds",
      "snowflake",
    ]);
  });

  it("lists the engines the form offers in the database hint, and not Oracle", () => {
    const hint = secretKindHint("database");
    expect(hint).toContain("PostgreSQL");
    expect(hint).toContain("MySQL");
    expect(hint).toContain("SQL Server");
    expect(hint).not.toContain("Oracle");
    expect(hint).not.toContain("Cassandra");
  });

  it("gives a non-database kind its fixed hint", () => {
    expect(secretKindHint("api_key")).toBe(
      "A key or token for an HTTPS service",
    );
  });
});

describe("labels", () => {
  it("names a known kind and protocol, and an unknown one by its own name", () => {
    expect(secretKindLabel("database")).toBe("Database login");
    expect(secretKindLabel("unknown_kind")).toBe("unknown_kind");
    expect(secretProtocolLabel("postgres")).toBe("PostgreSQL");
    expect(secretProtocolLabel("quic-from-the-future")).toBe(
      "quic-from-the-future",
    );
  });

  it("does not resolve a prototype key to a label", () => {
    expect(secretKindLabel("toString")).toBe("toString");
    expect(secretProtocolLabel("constructor")).toBe("constructor");
  });

  it("carries none of the words the product does not use for a person's settings", () => {
    const excluded = /\b(environments?|bindings?|placeholders?)\b/i;
    for (const [dialect, label] of Object.entries(SECRET_DIALECT_LABEL)) {
      expect(excluded.test(label), `${dialect}: ${label}`).toBe(false);
    }
  });

  it("proposes DATABASE_URL for an engine and nothing for an HTTP protocol", () => {
    expect(secretDefaultVariableName("postgres")).toBe("DATABASE_URL");
    expect(secretDefaultVariableName("https")).toBe("");
    expect(secretVariableDialects("https")).toEqual([]);
    expect(secretVariableDialects("redis")).toContain("redis-url");
  });
});

describe("a fresh form", () => {
  it("starts a database login on PostgreSQL with its port and its one variable", () => {
    const form = initialSecretForm("database");
    expect(form.protocol).toBe("postgres");
    expect(form.port).toBe("5432");
    expect(form.variables).toEqual([
      { id: 0, name: "DATABASE_URL", dialect: "libpq-url" },
    ]);
    expect(form.mode).toBe("brokered");
    expect(form.sandboxesByDefault).toBe(true);
    expect(form.plaintextConsent).toBe(false);
  });

  it("starts an API key on HTTPS with no port, no variables and the header site", () => {
    const form = initialSecretForm("api_key");
    expect(form.protocol).toBe("https");
    expect(form.port).toBe("");
    expect(form.variables).toEqual([]);
    expect(form.swapSites).toEqual(["header"]);
  });

  it("starts a model provider key on HTTPS too", () => {
    const form = initialSecretForm("provider");
    expect(form.protocol).toBe("https");
    expect(form.variables).toEqual([]);
  });
});

describe("withSecretProtocol", () => {
  it("takes the new engine's port and variable dialect and drops a consent given for another", () => {
    const next = withSecretProtocol(validDatabaseForm(), "mysql");
    expect(next.protocol).toBe("mysql");
    expect(next.port).toBe("3306");
    expect(next.variables).toEqual([
      { id: 0, name: "DATABASE_URL", dialect: "mysql-url" },
    ]);
    expect(next.plaintextConsent).toBe(false);
    // What still applies is kept.
    expect(next.name).toBe("PROD_DB");
    expect(next.hosts).toBe("a.example.com, b.example.com");
    expect(next.identity).toBe("app");
    expect(next.value).toBe("s3cret-db-password");
  });

  it("clears the port and variables moving an API key to another HTTP protocol", () => {
    const next = withSecretProtocol(validApiKeyForm(), "http");
    expect(next.port).toBe("");
    expect(next.variables).toEqual([]);
  });
});

describe("nextVariableId", () => {
  it("is the largest id plus one, and 0 for no variables", () => {
    const form = initialSecretForm("database");
    expect(nextVariableId({ ...form, variables: [] })).toBe(0);
    expect(nextVariableId(form)).toBe(1);
    expect(
      nextVariableId({
        ...form,
        variables: [
          { id: 0, name: "A", dialect: "login" },
          { id: 3, name: "B", dialect: "host" },
          { id: 1, name: "C", dialect: "port" },
        ],
      }),
    ).toBe(4);
  });
});

describe("the form's readers", () => {
  it("splits hosts on commas, spaces and new lines", () => {
    expect(
      secretFormHosts({
        ...validApiKeyForm(),
        hosts: "a.com, b.com\nc.com  d.com",
      }),
    ).toEqual(["a.com", "b.com", "c.com", "d.com"]);
    expect(secretFormHosts({ ...validApiKeyForm(), hosts: " , " })).toEqual([]);
  });

  it("reads an empty port as the default and an unreadable one as NaN", () => {
    expect(secretFormPort({ ...validApiKeyForm(), port: "" })).toBeNull();
    expect(secretFormPort({ ...validApiKeyForm(), port: " 8443 " })).toBe(8443);
    expect(secretFormPort({ ...validApiKeyForm(), port: "12ab" })).toBeNaN();
    expect(secretFormPort({ ...validApiKeyForm(), port: "123456" })).toBeNaN();
  });

  it("asks for consent only on a brokered database", () => {
    expect(secretFormNeedsConsent(validDatabaseForm())).toBe(true);
    expect(
      secretFormNeedsConsent({ ...validDatabaseForm(), mode: "exposed" }),
    ).toBe(false);
    expect(secretFormNeedsConsent(validApiKeyForm())).toBe(false);
  });
});

describe("secretFormProblem", () => {
  it("passes a valid brokered, consented database form", () => {
    expect(secretFormProblem(validDatabaseForm())).toBeNull();
  });

  it("passes a valid API key form", () => {
    expect(secretFormProblem(validApiKeyForm())).toBeNull();
  });

  it("refuses a name that is not capitals, digits and underscores", () => {
    const message =
      "The name is capital letters, digits and underscores, starting with a letter.";
    for (const name of ["", "lower", "1ABC", "HAS-DASH", "HAS SPACE"]) {
      expect(
        secretFormProblem({ ...validDatabaseForm(), name }),
        JSON.stringify(name),
      ).toBe(message);
    }
  });

  it("refuses no host", () => {
    expect(secretFormProblem({ ...validDatabaseForm(), hosts: "  " })).toBe(
      "Enter the server address.",
    );
  });

  it("refuses more than 16 hosts and accepts 16", () => {
    const hosts = (count: number): string =>
      Array.from({ length: count }, (_, index) => `h${index}.example.com`).join(
        ",",
      );
    expect(
      secretFormProblem({ ...validDatabaseForm(), hosts: hosts(17) }),
    ).toBe("A secret reaches at most 16 hosts.");
    expect(
      secretFormProblem({ ...validDatabaseForm(), hosts: hosts(16) }),
    ).toBeNull();
  });

  it("names a host that is not a hostname", () => {
    expect(
      secretFormProblem({
        ...validDatabaseForm(),
        hosts: "ok.example.com, bad$host",
      }),
    ).toBe(
      "bad$host is not a hostname: letters, digits, dots and dashes only.",
    );
    expect(
      secretFormProblem({
        ...validDatabaseForm(),
        hosts: "https://x.example.com",
      }),
    ).toContain("is not a hostname");
  });

  it("refuses a port outside 1 to 65535 or unreadable", () => {
    const message = "The port is a number from 1 to 65535.";
    for (const port of ["70000", "0", "abc", "-1"]) {
      expect(secretFormProblem({ ...validDatabaseForm(), port }), port).toBe(
        message,
      );
    }
    expect(
      secretFormProblem({ ...validDatabaseForm(), port: "65535" }),
    ).toBeNull();
    expect(secretFormProblem({ ...validDatabaseForm(), port: "" })).toBeNull();
  });

  it("asks a database for its login", () => {
    expect(secretFormProblem({ ...validDatabaseForm(), identity: "  " })).toBe(
      "Enter the login.",
    );
    // An API key has no login.
    expect(secretFormProblem(validApiKeyForm())).toBeNull();
  });

  it("asks for the value", () => {
    expect(secretFormProblem({ ...validDatabaseForm(), value: "" })).toBe(
      "Enter the value.",
    );
    expect(secretFormProblem({ ...validApiKeyForm(), value: "" })).toBe(
      "Enter the value.",
    );
  });

  it("asks an API key where it appears in a request", () => {
    expect(secretFormProblem({ ...validApiKeyForm(), swapSites: [] })).toBe(
      "Choose where the key appears in a request.",
    );
  });

  it("holds a brokered database for the plaintext notice, and an exposed one does not need it", () => {
    expect(
      secretFormProblem({ ...validDatabaseForm(), plaintextConsent: false }),
    ).toBe("Confirm the plaintext notice, or choose exposed.");
    expect(
      secretFormProblem({
        ...validDatabaseForm(),
        mode: "exposed",
        plaintextConsent: false,
      }),
    ).toBeNull();
  });

  it("refuses a protocol the table does not broker", () => {
    const oracle = withSecretProtocol(validDatabaseForm(), "oracle");
    expect(secretVerifyProblem(oracle)).toBe("Oracle is not brokered in v1.");
    expect(secretFormProblem(oracle)).toBe("Oracle is not brokered in v1.");
  });

  it("refuses a variable named twice, badly, or in a format the protocol lacks", () => {
    const form = validDatabaseForm();
    expect(
      secretFormProblem({
        ...form,
        variables: [
          { id: 0, name: "DATABASE_URL", dialect: "libpq-url" },
          { id: 1, name: "DATABASE_URL", dialect: "jdbc" },
        ],
      }),
    ).toBe("The variable DATABASE_URL is named twice.");
    expect(
      secretFormProblem({
        ...form,
        variables: [{ id: 0, name: "lower", dialect: "libpq-url" }],
      }),
    ).toBe(
      "A variable name is capital letters, digits and underscores, starting with a letter.",
    );
    expect(
      secretFormProblem({
        ...form,
        variables: [{ id: 0, name: "DATABASE_URL", dialect: "mysql-url" }],
      }),
    ).toBe("DATABASE_URL uses a format this protocol does not have.");
  });

  it("does not let the name stop Verify", () => {
    expect(
      secretVerifyProblem({ ...validDatabaseForm(), name: "" }),
    ).toBeNull();
  });
});

describe("secretCreateRequest", () => {
  it("shapes a brokered, consented PostgreSQL login", () => {
    const request = secretCreateRequest(validDatabaseForm());
    expect(request).toEqual({
      environmentId: null,
      name: "PROD_DB",
      kind: "database",
      protocol: "postgres",
      hosts: ["a.example.com", "b.example.com"],
      port: 5432,
      identity: "app",
      database: "orders",
      policy: {
        class: "database",
        engine: "postgres",
        database: "orders",
        upstreamMechanism: "scram-sha-256-plus",
        tdsVersion: null,
        members: [],
        plaintextConsentAt: null,
        authSource: null,
        replicaSet: null,
      },
      tlsPolicy: null,
      pinnedHostKeys: null,
      connectorId: null,
      confirmedAddresses: null,
      value: "s3cret-db-password",
      mode: "brokered",
      portOverride: false,
      swapSites: ["header"],
      // No `id`: the row's own key in the form is never sent.
      variables: [{ name: "DATABASE_URL", dialect: "libpq-url" }],
      exportPolicy: null,
      sandboxesByDefault: true,
      plaintextConsent: { disclosureVersion: 1 },
    });
    expect(request.variables.every((variable) => !("id" in variable))).toBe(
      true,
    );
  });

  it("sends the SQL Server TDS version", () => {
    const request = secretCreateRequest(
      withSecretProtocol(validDatabaseForm(), "tds"),
    );
    expect(request.protocol).toBe("tds");
    expect(request.port).toBe(1433);
    expect(request.policy).toMatchObject({
      class: "database",
      engine: "tds",
      tdsVersion: "7.4",
    });
  });

  it("carries no policy and no login for an API key, and keeps the chosen sites", () => {
    const request = secretCreateRequest({
      ...validApiKeyForm(),
      swapSites: ["header", "body"],
    });
    expect(request.kind).toBe("api_key");
    expect(request.policy).toBeNull();
    expect(request.identity).toBeNull();
    expect(request.database).toBeNull();
    expect(request.swapSites).toEqual(["header", "body"]);
    expect(request.variables).toEqual([]);
    expect(request.plaintextConsent).toBeNull();
    expect(request.value).toBe("sk_live_typed_value");
  });

  it("sends the header site for a model provider key whatever the form holds", () => {
    const request = secretCreateRequest({
      ...initialSecretForm("provider"),
      name: "ANTHROPIC_API_KEY",
      hosts: "api.anthropic.com",
      value: "sk-ant-typed",
      swapSites: [],
    });
    expect(request.swapSites).toEqual(["header"]);
  });

  it("carries no consent for an exposed database", () => {
    const request = secretCreateRequest({
      ...validDatabaseForm(),
      mode: "exposed",
    });
    expect(request.mode).toBe("exposed");
    expect(request.plaintextConsent).toBeNull();
  });

  it("carries no consent for a brokered database that was not confirmed", () => {
    const request = secretCreateRequest({
      ...validDatabaseForm(),
      plaintextConsent: false,
    });
    expect(request.plaintextConsent).toBeNull();
  });

  it("sends the default port as null and an unreadable port as null", () => {
    expect(
      secretCreateRequest({ ...validApiKeyForm(), port: "" }).port,
    ).toBeNull();
    expect(
      secretCreateRequest({ ...validApiKeyForm(), port: "nope" }).port,
    ).toBeNull();
    expect(
      secretCreateRequest({ ...validApiKeyForm(), port: "8443" }).port,
    ).toBe(8443);
  });

  it("trims a blank database to null", () => {
    const request = secretCreateRequest({
      ...validDatabaseForm(),
      database: "  ",
    });
    expect(request.database).toBeNull();
    expect(request.policy).toMatchObject({ database: null });
  });

  it("sends the per-engine upstream mechanism, strongest first", () => {
    const mysql = secretCreateRequest(
      withSecretProtocol(validDatabaseForm(), "mysql"),
    );
    expect(mysql.policy).toMatchObject({
      engine: "mysql",
      upstreamMechanism: "caching_sha2_password",
    });
  });
});

describe("secretVerifyCandidateRequest", () => {
  it("is a candidate with the value and the binding fields, and no name", () => {
    const form = validDatabaseForm();
    const request = secretVerifyCandidateRequest(form);
    expect(request.target).toBe("candidate");
    expect("name" in request).toBe(false);
    if (request.target !== "candidate") {
      throw new Error("expected a candidate request");
    }
    expect(request.value).toBe("s3cret-db-password");
    expect(request.kind).toBe("database");
    expect(request.protocol).toBe("postgres");
    expect(request.hosts).toEqual(["a.example.com", "b.example.com"]);
    expect(request.port).toBe(5432);
    expect(request.identity).toBe("app");
    expect(request.database).toBe("orders");
    expect(request.tlsPolicy).toBeNull();
    expect(request.pinnedHostKeys).toBeNull();
    expect(request.connectorId).toBeNull();
    expect(request.confirmedAddresses).toBeNull();

    // The same binding the create carries, field for field.
    const create = secretCreateRequest(form);
    expect(request.policy).toEqual(create.policy);
    expect(request.hosts).toEqual(create.hosts);
    expect(request.port).toBe(create.port);
    expect(request.identity).toBe(create.identity);
    expect(request.value).toBe(create.value);
  });

  it("carries none of the create-only fields", () => {
    const keys = Object.keys(secretVerifyCandidateRequest(validApiKeyForm()));
    for (const field of [
      "name",
      "mode",
      "portOverride",
      "swapSites",
      "variables",
      "exportPolicy",
      "sandboxesByDefault",
      "plaintextConsent",
    ]) {
      expect(keys, field).not.toContain(field);
    }
  });
});

describe("secretVerifyLine", () => {
  it("names the port setting on a row when nothing answered on the port", () => {
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "port" },
        "https",
        "row",
      ),
    ).toEqual({
      tone: "warning",
      text: "Nothing answered on that port. Check the port this secret is set to.",
    });
  });

  it("points above, in the dialog, at the same setting", () => {
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "port" },
        "https",
        "dialog",
      ),
    ).toEqual({
      tone: "warning",
      text: "Nothing answered on that port. Check the port above.",
    });
  });

  it("names the host setting when the host did not answer", () => {
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "host" },
        "https",
        "row",
      ).text,
    ).toBe("The host did not answer. Check the host this secret is set to.");
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "host" },
        "https",
        "dialog",
      ).text,
    ).toBe("The host did not answer. Check the host above.");
  });

  it("names the login and value when the login was refused", () => {
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "login" },
        "postgres",
        "row",
      ).text,
    ).toBe(
      "The server refused the login. Check the login and value this secret is set to.",
    );
    expect(
      secretVerifyLine(
        { evidence: "probe_refused", hop: "login" },
        "postgres",
        "dialog",
      ).text,
    ).toBe("The server refused the login. Check the login and value above.");
  });

  it("names the protocol, by its label, when something else answered", () => {
    const line = secretVerifyLine(
      { evidence: "probe_refused", hop: "protocol" },
      "postgres",
      "dialog",
    );
    expect(line.tone).toBe("warning");
    expect(line.text).toBe(
      "Something answered, but not PostgreSQL. Check the port and protocol above.",
    );
  });

  it("says an accepted HTTPS probe reached the destination only", () => {
    const line = secretVerifyLine(
      { evidence: "probe_accepted" },
      "https",
      "row",
    );
    expect(line.tone).toBe("success");
    expect(line.text).toContain("checked the first time an agent uses it");
    expect(line.text).not.toContain("logged in");
  });

  it("says an accepted database probe logged in", () => {
    expect(
      secretVerifyLine({ evidence: "probe_accepted" }, "postgres", "row"),
    ).toEqual({
      tone: "success",
      text: "Reached the database and logged in.",
    });
    expect(
      secretVerifyLine({ evidence: "probe_accepted" }, "neon-ws", "dialog")
        .text,
    ).toBe("Reached the database and logged in.");
  });

  it("does not say it logged in for Oracle, which is not an engine", () => {
    expect(
      secretVerifyLine({ evidence: "probe_accepted" }, "oracle", "row").text,
    ).toContain("checked the first time an agent uses it");
  });

  it("asks to try again when nothing could be checked", () => {
    expect(
      secretVerifyLine({ evidence: "unreachable" }, "https", "row"),
    ).toEqual({
      tone: "warning",
      text: "Couldn't check right now. Try again in a moment.",
    });
  });
});
