import { describe, expect, it } from "vitest";
import {
  SANDBOX_CONNECTION_DIALECTS,
  SANDBOX_DATABASE_COMMITTED_AFTER_CUT,
  SANDBOX_DATABASE_DEFAULT_PORT,
  SANDBOX_DATABASE_DIALECTS,
  SANDBOX_DATABASE_ENGINES,
  SANDBOX_DATABASE_UPSTREAM_MECHANISMS,
  SANDBOX_PLAINTEXT_DISCLOSURE_VERSION,
  SANDBOX_ROUTE_PROTOCOLS,
  SANDBOX_SECRET_FORM_KINDS,
  SANDBOX_SECRET_KINDS,
  SANDBOX_SECRET_KIND_PROTOCOLS,
  SANDBOX_UNBROKERED,
  SANDBOX_UNBROKERED_FAMILIES,
  isSandboxDatabaseEngine,
  sandboxDatabaseConsentCopy,
  sandboxUnbrokeredRowFor,
  type SandboxRouteProtocol,
} from "@traycer/protocol/host/secret-intake-catalogue";

describe("sandboxUnbrokeredRowFor", () => {
  const REFUSED: readonly SandboxRouteProtocol[] = [
    "kafka",
    "amqp",
    "mqtt",
    "smtp",
    "imap",
    "pop3",
    "rdp",
    "oracle",
    "cassandra",
  ];

  it.each(REFUSED)("returns a row with its copy for %s", (protocol) => {
    const row = sandboxUnbrokeredRowFor(protocol);
    expect(row).not.toBeNull();
    expect(row?.protocols).toContain(protocol);
    expect(row?.copy.length).toBeGreaterThan(0);
    expect(row?.copy).toMatch(/is not brokered in v1\.$/);
  });

  it("returns the mail row for each of SMTP, IMAP and POP3", () => {
    const mail = SANDBOX_UNBROKERED.mail;
    expect(sandboxUnbrokeredRowFor("smtp")).toBe(mail);
    expect(sandboxUnbrokeredRowFor("imap")).toBe(mail);
    expect(sandboxUnbrokeredRowFor("pop3")).toBe(mail);
    expect(mail.copy).toBe("Mail (SMTP, IMAP and POP3) is not brokered in v1.");
  });

  it.each(["https", "postgres", "ssh", "sigv4"] as const)(
    "returns null for the brokered protocol %s",
    (protocol) => {
      expect(sandboxUnbrokeredRowFor(protocol)).toBeNull();
    },
  );

  it("refuses exactly the protocols the families list, and no other", () => {
    const listed = new Set<SandboxRouteProtocol>(
      SANDBOX_UNBROKERED_FAMILIES.flatMap(
        (family) => SANDBOX_UNBROKERED[family].protocols,
      ),
    );
    const refused = SANDBOX_ROUTE_PROTOCOLS.filter(
      (protocol) => sandboxUnbrokeredRowFor(protocol) !== null,
    );
    expect(new Set(refused)).toEqual(listed);
    expect(new Set(refused)).toEqual(new Set(REFUSED));
  });
});

describe("the kind tables", () => {
  it("admits only route protocols for every kind", () => {
    for (const kind of SANDBOX_SECRET_KINDS) {
      for (const protocol of SANDBOX_SECRET_KIND_PROTOCOLS[kind]) {
        expect(SANDBOX_ROUTE_PROTOCOLS, `${kind} admits ${protocol}`).toContain(
          protocol,
        );
      }
    }
  });

  it("gives every kind at least one protocol", () => {
    for (const kind of SANDBOX_SECRET_KINDS) {
      expect(SANDBOX_SECRET_KIND_PROTOCOLS[kind].length, kind).toBeGreaterThan(
        0,
      );
    }
  });

  it("leaves github, harness and mcp_credential out of the form's kinds", () => {
    expect(SANDBOX_SECRET_FORM_KINDS).not.toContain("github");
    expect(SANDBOX_SECRET_FORM_KINDS).not.toContain("harness");
    expect(SANDBOX_SECRET_FORM_KINDS).not.toContain("mcp_credential");
    expect(SANDBOX_SECRET_FORM_KINDS).toHaveLength(
      SANDBOX_SECRET_KINDS.length - 3,
    );
    for (const kind of SANDBOX_SECRET_FORM_KINDS) {
      expect(SANDBOX_SECRET_KINDS).toContain(kind);
    }
  });

  it("lists every connection dialect once", () => {
    expect(new Set(SANDBOX_CONNECTION_DIALECTS).size).toBe(
      SANDBOX_CONNECTION_DIALECTS.length,
    );
  });
});

describe("the database engines", () => {
  it("are all protocols of the database kind", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      expect(SANDBOX_SECRET_KIND_PROTOCOLS.database, engine).toContain(engine);
    }
  });

  it("are never in the not-brokered table", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      expect(sandboxUnbrokeredRowFor(engine), engine).toBeNull();
    }
  });

  it("leave out exactly the database protocols that are not brokered", () => {
    const notEngines = SANDBOX_SECRET_KIND_PROTOCOLS.database.filter(
      (protocol) => !isSandboxDatabaseEngine(protocol),
    );
    expect(notEngines).toEqual(["oracle", "cassandra"]);
    for (const protocol of notEngines) {
      expect(sandboxUnbrokeredRowFor(protocol), protocol).not.toBeNull();
    }
  });

  it("each name only dialects that are connection dialects", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      for (const dialect of SANDBOX_DATABASE_DIALECTS[engine]) {
        expect(SANDBOX_CONNECTION_DIALECTS, `${engine}: ${dialect}`).toContain(
          dialect,
        );
      }
    }
  });

  it("each admit the four scalar dialects", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      for (const dialect of ["login", "placeholder", "host", "port"] as const) {
        expect(SANDBOX_DATABASE_DIALECTS[engine], engine).toContain(dialect);
      }
    }
  });

  it("each have a default port in range and a non-empty mechanism list", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      const port = SANDBOX_DATABASE_DEFAULT_PORT[engine];
      expect(Number.isInteger(port), engine).toBe(true);
      expect(port, engine).toBeGreaterThanOrEqual(1);
      expect(port, engine).toBeLessThanOrEqual(65_535);
      expect(
        SANDBOX_DATABASE_UPSTREAM_MECHANISMS[engine].length,
        engine,
      ).toBeGreaterThan(0);
    }
  });

  it("each have a gate T figure entry, null or a count out of 100", () => {
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      const figure = SANDBOX_DATABASE_COMMITTED_AFTER_CUT[engine];
      if (figure !== null) {
        expect(figure, engine).toBeGreaterThanOrEqual(0);
        expect(figure, engine).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("isSandboxDatabaseEngine", () => {
  it("is true for the engines", () => {
    expect(isSandboxDatabaseEngine("postgres")).toBe(true);
    expect(isSandboxDatabaseEngine("neon-ws")).toBe(true);
    for (const engine of SANDBOX_DATABASE_ENGINES) {
      expect(isSandboxDatabaseEngine(engine), engine).toBe(true);
    }
  });

  it("is false for the not-brokered database protocols and for other kinds", () => {
    expect(isSandboxDatabaseEngine("oracle")).toBe(false);
    expect(isSandboxDatabaseEngine("cassandra")).toBe(false);
    expect(isSandboxDatabaseEngine("https")).toBe(false);
    expect(isSandboxDatabaseEngine("ssh")).toBe(false);
  });
});

describe("sandboxDatabaseConsentCopy", () => {
  it("states the measured figure in the second line when the engine has one", () => {
    const [first, second] = sandboxDatabaseConsentCopy("postgres");
    expect(first).toContain("pass through Traycer's gateway in plaintext");
    expect(second).toContain("38 of 100");
    expect(second).toContain("PostgreSQL");
  });

  it("names the engine as the person knows it", () => {
    expect(sandboxDatabaseConsentCopy("neon-ws")[1]).toContain(
      "on PostgreSQL landed",
    );
    expect(sandboxDatabaseConsentCopy("tds")[1]).toContain("on SQL Server");
    expect(sandboxDatabaseConsentCopy("mysql")[1]).toContain("41 of 100");
  });

  it("states no figure for an engine whose run does not exist yet", () => {
    expect(SANDBOX_DATABASE_COMMITTED_AFTER_CUT.snowflake).toBeNull();
    const [first, second] = sandboxDatabaseConsentCopy("snowflake");
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toContain("of 100");
    expect(second.endsWith("already committed.")).toBe(true);
  });
});

describe("SANDBOX_PLAINTEXT_DISCLOSURE_VERSION", () => {
  it("is version 1, the version of today's consent lines", () => {
    expect(SANDBOX_PLAINTEXT_DISCLOSURE_VERSION).toBe(1);
  });
});
