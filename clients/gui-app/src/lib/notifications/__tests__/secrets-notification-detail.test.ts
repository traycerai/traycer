import { describe, expect, it } from "vitest";
import {
  secretGrantDecisions,
  secretGrantDefaultConfirmation,
  secretGrantRequestDestination,
  secretGrantRequestReason,
  secretRequestDecidedByLine,
  secretRequestStatusLine,
  secretsNotificationDetail,
  type SecretsNotificationDetail,
} from "@/lib/notifications/secrets-notification-detail";

type GrantRequestDetail = Extract<
  SecretsNotificationDetail,
  { kind: "grant-request" }
>;
const GRANT_PAYLOAD = {
  kind: "secret_grant_request",
  requestId: "request-1",
  hostId: "host-1",
  secretName: "DB_PASSWORD",
  destination: "db.example.com",
  port: 3306,
  protocol: "mysql",
  reason: "Run the migration",
  sandboxName: "build-box",
  agentId: "agent-1",
  epicId: "epic-1",
  chatId: "chat-1",
};

const MINIMAL_GRANT_PAYLOAD = {
  kind: "secret_grant_request",
  requestId: "request-2",
  hostId: "host-1",
  secretName: null,
  destination: null,
  protocol: null,
  reason: "",
};

const EXPORT_PAYLOAD = {
  kind: "secret_export_minted",
  secretName: "DEPLOY_KEY",
  exportKind: "presigned_url",
  expiresAt: 1_700_000_900_000,
  hostId: "host-1",
};

function grantDetail(
  overrides: Partial<GrantRequestDetail>,
): GrantRequestDetail {
  return {
    kind: "grant-request",
    requestId: "request-1",
    secretName: "DB_PASSWORD",
    destination: "db.example.com",
    port: null,
    protocol: null,
    reason: "Run the migration",
    sandboxName: null,
    environmentId: null,
    teamName: null,
    decision: null,
    decidedBy: null,
    ...overrides,
  };
}

describe("secretsNotificationDetail", () => {
  it("reads a grant request into every field of its detail", () => {
    expect(
      secretsNotificationDetail("secret.grant.requested", GRANT_PAYLOAD),
    ).toEqual({
      kind: "grant-request",
      requestId: "request-1",
      secretName: "DB_PASSWORD",
      destination: "db.example.com",
      port: 3306,
      protocol: "mysql",
      reason: "Run the migration",
      sandboxName: "build-box",
      environmentId: null,
      teamName: null,
      decision: null,
      decidedBy: null,
    });
  });

  it("reads a team request's environment and team, and who settled it", () => {
    expect(
      secretsNotificationDetail("secret.grant.requested", {
        ...GRANT_PAYLOAD,
        environmentId: "env-team-1",
        teamName: "Acme",
        decision: "approved",
        decidedBy: "Ana",
      }),
    ).toEqual({
      kind: "grant-request",
      requestId: "request-1",
      secretName: "DB_PASSWORD",
      destination: "db.example.com",
      port: 3306,
      protocol: "mysql",
      reason: "Run the migration",
      sandboxName: "build-box",
      environmentId: "env-team-1",
      teamName: "Acme",
      decision: "approved",
      decidedBy: "Ana",
    });
  });

  it("reads null team fields, as a Personal request carries them, as null", () => {
    expect(
      secretsNotificationDetail("secret.grant.requested", {
        ...GRANT_PAYLOAD,
        environmentId: null,
        teamName: null,
        decision: null,
        decidedBy: null,
      }),
    ).toMatchObject({
      environmentId: null,
      teamName: null,
      decision: null,
      decidedBy: null,
    });
  });

  it("turns a missing port and sandbox name into null", () => {
    expect(
      secretsNotificationDetail(
        "secret.grant.requested",
        MINIMAL_GRANT_PAYLOAD,
      ),
    ).toEqual({
      kind: "grant-request",
      requestId: "request-2",
      secretName: null,
      destination: null,
      port: null,
      protocol: null,
      reason: "",
      sandboxName: null,
      environmentId: null,
      teamName: null,
      decision: null,
      decidedBy: null,
    });
  });

  it("returns null when the payload belongs to the other secrets kind", () => {
    expect(
      secretsNotificationDetail("secret.grant.requested", EXPORT_PAYLOAD),
    ).toBeNull();
    expect(
      secretsNotificationDetail("secret.export.minted", GRANT_PAYLOAD),
    ).toBeNull();
  });

  it("returns null for an unrelated kind, even with a secrets payload", () => {
    expect(
      secretsNotificationDetail("agent.stopped", GRANT_PAYLOAD),
    ).toBeNull();
  });

  it("returns null for an unreadable payload", () => {
    expect(
      secretsNotificationDetail("secret.grant.requested", null),
    ).toBeNull();
    expect(
      secretsNotificationDetail("secret.export.minted", {
        kind: "secret_export_minted",
      }),
    ).toBeNull();
  });
});

describe("secretGrantRequestReason", () => {
  it("returns null for a blank reason", () => {
    expect(secretGrantRequestReason("")).toBeNull();
    expect(secretGrantRequestReason("  \n ")).toBeNull();
  });

  it("trims the reason", () => {
    expect(secretGrantRequestReason("  Run the migration \n")).toBe(
      "Run the migration",
    );
  });

  it("keeps a reason of exactly the longest length whole", () => {
    const reason = "a".repeat(400);
    expect(secretGrantRequestReason(reason)).toBe(reason);
  });

  it("cuts a longer reason at 400 characters and marks the cut", () => {
    expect(secretGrantRequestReason("b".repeat(401))).toBe(
      `${"b".repeat(400)}…`,
    );
  });
});

describe("secretGrantRequestDestination", () => {
  it("returns null with no destination", () => {
    expect(
      secretGrantRequestDestination(
        grantDetail({ destination: null, port: 5432, protocol: "postgres" }),
      ),
    ).toBeNull();
  });

  it("returns the bare destination without a port or protocol", () => {
    expect(
      secretGrantRequestDestination(
        grantDetail({ destination: "db.internal" }),
      ),
    ).toBe("db.internal");
  });

  it("appends the port when there is one", () => {
    expect(
      secretGrantRequestDestination(
        grantDetail({ destination: "db.internal", port: 5432 }),
      ),
    ).toBe("db.internal:5432");
  });

  it("appends the protocol in parentheses", () => {
    expect(
      secretGrantRequestDestination(
        grantDetail({
          destination: "db.internal",
          port: 5432,
          protocol: "postgres",
        }),
      ),
    ).toBe("db.internal:5432 (postgres)");
    expect(
      secretGrantRequestDestination(
        grantDetail({ destination: "db.internal", protocol: "postgres" }),
      ),
    ).toBe("db.internal (postgres)");
  });
});

describe("secretGrantDecisions", () => {
  it("offers the three decisions in order with their labels on a personal request", () => {
    expect(secretGrantDecisions(null)).toEqual([
      { decision: "approve", label: "Approve for this sandbox" },
      { decision: "approve_default", label: "Approve for all sandboxes" },
      { decision: "decline", label: "Decline" },
    ]);
  });

  it("names the team on the wide approval of a team request", () => {
    expect(secretGrantDecisions("Acme")).toEqual([
      { decision: "approve", label: "Approve for this sandbox" },
      {
        decision: "approve_default",
        label: "Approve for all Acme sandboxes",
      },
      { decision: "decline", label: "Decline" },
    ]);
  });
});

describe("secretGrantDefaultConfirmation", () => {
  it("is null on a personal request, which needs none", () => {
    expect(secretGrantDefaultConfirmation(null, "DB_PASSWORD")).toBeNull();
    expect(secretGrantDefaultConfirmation(null, null)).toBeNull();
  });

  it("names the team and the secret on a team request", () => {
    expect(secretGrantDefaultConfirmation("Acme", "DB_PASSWORD")).toBe(
      "Every current and future Acme sandbox will hold DB_PASSWORD.",
    );
  });

  it("says this secret when the request names none", () => {
    expect(secretGrantDefaultConfirmation("Acme", null)).toBe(
      "Every current and future Acme sandbox will hold this secret.",
    );
  });
});

describe("secretRequestDecidedByLine", () => {
  it.each([
    ["approved", "Approved by Ana."],
    ["approved_default", "Approved by Ana."],
    ["declined", "Declined by Ana."],
  ])("reads %s as a line naming who answered", (status, line) => {
    expect(secretRequestDecidedByLine(status, "Ana")).toBe(line);
  });

  it("is null when nobody is named", () => {
    expect(secretRequestDecidedByLine("approved", null)).toBeNull();
    expect(secretRequestDecidedByLine("declined", null)).toBeNull();
  });

  it("is null for a status that no person settled", () => {
    expect(secretRequestDecidedByLine("expired", "Ana")).toBeNull();
    expect(secretRequestDecidedByLine("pending", "Ana")).toBeNull();
    expect(secretRequestDecidedByLine("revoked", "Ana")).toBeNull();
  });
});

describe("secretRequestStatusLine", () => {
  it.each([
    ["approved", "Approved for this sandbox, for as long as it exists."],
    [
      "approved_default",
      "Approved for this sandbox, and every new sandbox gets it by default.",
    ],
    ["declined", "Declined. Nothing was granted and the agent has been told."],
    ["expired", "This request expired before it was answered."],
    ["pending", "This request is still waiting for an answer."],
  ])("describes %s", (status, line) => {
    expect(secretRequestStatusLine(status)).toBe(line);
  });

  it("reads a status this build does not know as closed", () => {
    expect(secretRequestStatusLine("revoked")).toBe("This request is closed.");
  });

  it("does not read an inherited object property as a known status", () => {
    expect(secretRequestStatusLine("toString")).toBe("This request is closed.");
  });
});
