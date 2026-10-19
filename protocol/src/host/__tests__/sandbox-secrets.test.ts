import { describe, expect, it } from "vitest";
import {
  SANDBOX_GRANT_MODE_BROKERED,
  SANDBOX_GRANT_MODE_EXPOSED,
  SECRET_REQUEST_CODE_SECRET_REQUIRED,
  SECRET_REQUEST_DECISIONS,
  SECRET_REQUEST_STATUSES,
  SECRET_REQUEST_STATUS_OF_DECISION,
  sandboxGrantRouteSchema,
  SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE,
  sandboxGrantSchema,
  sandboxGrantsSummarySchema,
  secretRequestDecideBodySchema,
} from "@traycer/protocol/host/sandbox-secrets";

const ROUTE = {
  route: "route-1",
  destination: "db.example.com",
  port: 3306,
  unready: null,
};

const BROKERED_GRANT = {
  secretName: "DB_PASSWORD",
  kind: "password",
  protocol: "mysql",
  mode: "brokered",
  source: "approved",
  connectorName: "office-vpn",
  rotation: null,
  routes: [ROUTE],
};

const EXPOSED_GRANT = {
  secretName: "STRIPE_KEY",
  kind: "api_key",
  protocol: "https",
  mode: "exposed",
  source: "default",
  connectorName: null,
  rotation: null,
  routes: [],
};

const SUMMARY = {
  version: 7,
  grants: [BROKERED_GRANT, EXPOSED_GRANT],
  github: {
    linked: true,
    installations: [
      { account: "traycerai", repositorySelection: "selected" },
      { account: "someone", repositorySelection: "all" },
    ],
  },
};

describe("sandboxGrantsSummarySchema", () => {
  it("parses the full shape the broker answers with", () => {
    const parsed = sandboxGrantsSummarySchema.parse(SUMMARY);
    expect(parsed).toEqual(SUMMARY);
  });

  it("parses an empty grant set", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      version: 0,
      grants: [],
      github: { linked: false, installations: [] },
    });
    expect(parsed.grants).toEqual([]);
    expect(parsed.github).toEqual({ linked: false, installations: [] });
  });

  it("reads a missing github as null", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      version: SUMMARY.version,
      grants: SUMMARY.grants,
    });
    expect(parsed.github).toBeNull();
    expect(parsed.grants).toHaveLength(2);
  });

  it("reads an explicit null github as null", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      ...SUMMARY,
      github: null,
    });
    expect(parsed.github).toBeNull();
  });

  it("reads a missing installations list as empty", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      ...SUMMARY,
      github: { linked: true },
    });
    expect(parsed.github).toEqual({ linked: true, installations: [] });
  });

  it("ignores unknown extra keys at every level", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      ...SUMMARY,
      futureTopLevel: 1,
      grants: [
        {
          ...BROKERED_GRANT,
          futureGrantField: "x",
          routes: [{ ...ROUTE, futureRouteField: true }],
        },
      ],
      github: {
        linked: true,
        futureGithubField: [],
        installations: [
          {
            account: "traycerai",
            repositorySelection: "all",
            futureInstallationField: 1,
          },
        ],
      },
    });
    expect(parsed).toEqual({
      version: 7,
      grants: [BROKERED_GRANT],
      github: {
        linked: true,
        installations: [{ account: "traycerai", repositorySelection: "all" }],
      },
    });
  });

  it("accepts a mode, source, kind, protocol and repositorySelection it does not know", () => {
    const parsed = sandboxGrantsSummarySchema.parse({
      ...SUMMARY,
      grants: [
        {
          ...BROKERED_GRANT,
          mode: "tunnelled",
          source: "delegated",
          kind: "client_certificate",
          protocol: "rdp",
        },
      ],
      github: {
        linked: true,
        installations: [{ account: "a", repositorySelection: "none" }],
      },
    });
    expect(parsed.grants[0]).toMatchObject({
      mode: "tunnelled",
      source: "delegated",
      kind: "client_certificate",
      protocol: "rdp",
    });
    expect(parsed.github?.installations[0].repositorySelection).toBe("none");
  });

  it("keeps the two known modes as the strings the broker sends", () => {
    expect(SANDBOX_GRANT_MODE_BROKERED).toBe("brokered");
    expect(SANDBOX_GRANT_MODE_EXPOSED).toBe("exposed");
  });

  it("rejects a summary without a grants list", () => {
    expect(
      sandboxGrantsSummarySchema.safeParse({
        version: SUMMARY.version,
        github: SUMMARY.github,
      }).success,
    ).toBe(false);
  });

  it("rejects a summary without a version", () => {
    expect(
      sandboxGrantsSummarySchema.safeParse({
        grants: SUMMARY.grants,
        github: SUMMARY.github,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-numeric version", () => {
    expect(
      sandboxGrantsSummarySchema.safeParse({ ...SUMMARY, version: "7" })
        .success,
    ).toBe(false);
  });

  it("rejects a github block without the linked flag", () => {
    expect(
      sandboxGrantsSummarySchema.safeParse({
        ...SUMMARY,
        github: { installations: [] },
      }).success,
    ).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(sandboxGrantsSummarySchema.safeParse(null).success).toBe(false);
    expect(sandboxGrantsSummarySchema.safeParse("grants").success).toBe(false);
    expect(sandboxGrantsSummarySchema.safeParse([]).success).toBe(false);
  });
});

describe("sandboxGrantSchema", () => {
  it("defaults a missing connectorName to null and missing routes to empty", () => {
    const parsed = sandboxGrantSchema.parse({
      secretName: "TOKEN",
      kind: "token",
      protocol: "https",
      mode: "exposed",
      source: "inherited",
    });
    expect(parsed.connectorName).toBeNull();
    expect(parsed.routes).toEqual([]);
  });

  it("rejects an empty secretName", () => {
    expect(
      sandboxGrantSchema.safeParse({ ...BROKERED_GRANT, secretName: "" })
        .success,
    ).toBe(false);
  });

  it("rejects a grant missing kind", () => {
    const { kind: _kind, ...rest } = BROKERED_GRANT;
    expect(sandboxGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a grant missing protocol", () => {
    const { protocol: _protocol, ...rest } = BROKERED_GRANT;
    expect(sandboxGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a grant missing mode", () => {
    const { mode: _mode, ...rest } = BROKERED_GRANT;
    expect(sandboxGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a grant missing source", () => {
    const { source: _source, ...rest } = BROKERED_GRANT;
    expect(sandboxGrantSchema.safeParse(rest).success).toBe(false);
  });
});

describe("sandboxGrantRouteSchema", () => {
  it("defaults a missing port to null and accepts an explicit null", () => {
    expect(
      sandboxGrantRouteSchema.parse({ route: "r", destination: "d" }).port,
    ).toBeNull();
    expect(
      sandboxGrantRouteSchema.parse({
        route: "r",
        destination: "d",
        port: null,
      }).port,
    ).toBeNull();
  });

  it("defaults a missing unready to null, and keeps the broker's word when it sends one", () => {
    expect(
      sandboxGrantRouteSchema.parse({ route: "r", destination: "d" }).unready,
    ).toBeNull();
    expect(
      sandboxGrantRouteSchema.parse({
        ...ROUTE,
        unready: SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE,
      }).unready,
    ).toBe("connector_offline");
    // A reason a newer broker names still parses: the route is shown as one
    // that cannot be used, not dropped with the whole summary.
    expect(
      sandboxGrantRouteSchema.parse({ ...ROUTE, unready: "future_reason" })
        .unready,
    ).toBe("future_reason");
    expect(
      sandboxGrantRouteSchema.safeParse({ ...ROUTE, unready: "" }).success,
    ).toBe(false);
  });

  it("rejects an empty route or destination", () => {
    expect(
      sandboxGrantRouteSchema.safeParse({ ...ROUTE, route: "" }).success,
    ).toBe(false);
    expect(
      sandboxGrantRouteSchema.safeParse({ ...ROUTE, destination: "" }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, "3306"])("rejects the port %s", (port) => {
    expect(sandboxGrantRouteSchema.safeParse({ ...ROUTE, port }).success).toBe(
      false,
    );
  });
});

describe("secretRequestDecideBodySchema", () => {
  it("parses a status with a code", () => {
    expect(
      secretRequestDecideBodySchema.parse({
        status: "pending",
        code: SECRET_REQUEST_CODE_SECRET_REQUIRED,
      }),
    ).toEqual({ status: "pending", code: "secret_required", decidedBy: null });
  });

  it("defaults a missing code to null", () => {
    expect(secretRequestDecideBodySchema.parse({ status: "approved" })).toEqual(
      { status: "approved", code: null, decidedBy: null },
    );
  });

  it("keeps the display name of the person who answered", () => {
    expect(
      secretRequestDecideBodySchema.parse({
        status: "approved",
        decidedBy: "Ana",
      }),
    ).toEqual({ status: "approved", code: null, decidedBy: "Ana" });
  });

  it("accepts an explicit null decidedBy", () => {
    expect(
      secretRequestDecideBodySchema.parse({
        status: "expired",
        decidedBy: null,
      }),
    ).toEqual({ status: "expired", code: null, decidedBy: null });
  });

  it("rejects an empty or non-string decidedBy", () => {
    expect(
      secretRequestDecideBodySchema.safeParse({
        status: "approved",
        decidedBy: "",
      }).success,
    ).toBe(false);
    expect(
      secretRequestDecideBodySchema.safeParse({
        status: "approved",
        decidedBy: 7,
      }).success,
    ).toBe(false);
  });

  it("accepts an explicit null code", () => {
    expect(
      secretRequestDecideBodySchema.parse({ status: "declined", code: null }),
    ).toEqual({ status: "declined", code: null, decidedBy: null });
  });

  it("accepts a status and a code it does not know", () => {
    expect(SECRET_REQUEST_STATUSES).not.toContain("revoked");
    expect(
      secretRequestDecideBodySchema.parse({
        status: "revoked",
        code: "some_future_code",
      }),
    ).toEqual({
      status: "revoked",
      code: "some_future_code",
      decidedBy: null,
    });
  });

  it("ignores unknown extra keys", () => {
    expect(
      secretRequestDecideBodySchema.parse({ status: "approved", extra: 1 }),
    ).toEqual({ status: "approved", code: null, decidedBy: null });
  });

  it("rejects a missing or empty status", () => {
    expect(secretRequestDecideBodySchema.safeParse({}).success).toBe(false);
    expect(
      secretRequestDecideBodySchema.safeParse({ status: "" }).success,
    ).toBe(false);
  });

  it("rejects a non-string status or code", () => {
    expect(
      secretRequestDecideBodySchema.safeParse({ status: 200 }).success,
    ).toBe(false);
    expect(
      secretRequestDecideBodySchema.safeParse({ status: "pending", code: 409 })
        .success,
    ).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(secretRequestDecideBodySchema.safeParse(null).success).toBe(false);
    expect(secretRequestDecideBodySchema.safeParse("approved").success).toBe(
      false,
    );
  });
});

describe("secret request decisions", () => {
  it("lists exactly the three decisions", () => {
    expect([...SECRET_REQUEST_DECISIONS]).toEqual([
      "approve",
      "approve_default",
      "decline",
    ]);
  });

  it("maps every decision to the status it leaves the request in", () => {
    for (const decision of SECRET_REQUEST_DECISIONS) {
      const status = SECRET_REQUEST_STATUS_OF_DECISION[decision];
      expect(SECRET_REQUEST_STATUSES).toContain(status);
    }
    expect(SECRET_REQUEST_STATUS_OF_DECISION).toEqual({
      approve: "approved",
      approve_default: "approved_default",
      decline: "declined",
    });
  });

  it("maps no decision to pending or expired", () => {
    const reached = SECRET_REQUEST_DECISIONS.map(
      (decision) => SECRET_REQUEST_STATUS_OF_DECISION[decision],
    );
    expect(reached).not.toContain("pending");
    expect(reached).not.toContain("expired");
  });

  it("names the secret-required code", () => {
    expect(SECRET_REQUEST_CODE_SECRET_REQUIRED).toBe("secret_required");
  });
});
