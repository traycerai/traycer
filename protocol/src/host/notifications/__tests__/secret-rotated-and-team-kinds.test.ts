import { describe, expect, it } from "vitest";
import { RPC_ERROR_CODES } from "@traycer/protocol/framework/versioned-rpc-types";
import {
  formatHostNotificationPresentation,
  hiddenHostNotificationKinds,
  hostNotificationEntrySchemaV22,
  hostNotificationEntrySchemaV23,
  hostNotificationSecretGrantRequestPayloadSchema,
  parseKnownHostNotificationPayloadForKind,
  visibleHostNotificationKinds,
  type HostNotificationKind,
  type HostNotificationsSurface,
} from "@traycer/protocol/host/notifications/contracts";
import { sandboxGrantSchema } from "@traycer/protocol/host/sandbox-secrets";

/**
 * `secret.rotated` and the seven team kinds ride list `@2.3` / feed `@1.4` /
 * cloudFeed `@1.3`: absent from every older minor, present from these up. Their
 * payloads read state, status, evidence kind and reason as open strings, so a
 * value newer than this build still parses and the copy never claims more than
 * the payload proves.
 */

const NEW_KINDS = [
  "secret.rotated",
  "team.member.removed",
  "team.member.joined",
  "team.policy.unapplied",
  "team.policy.authority_expired",
  "team.installing_admin.gone",
  "team.plan.unlinked",
  "team.pods.full",
] as const satisfies readonly HostNotificationKind[];

type NewKind = (typeof NEW_KINDS)[number];

const LIST: HostNotificationsSurface = { method: "host.notifications.list" };
const FEED: HostNotificationsSurface = {
  method: "host.notifications.feed.subscribe",
};
const CLOUD_FEED: HostNotificationsSurface = {
  method: "host.notifications.cloudFeed.subscribe",
};

const ENTRY_BASE = {
  id: "entry-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "source-1",
  epicId: null,
  chatId: null,
};

const ROTATED_PAYLOAD = {
  kind: "secret_rotated",
  secretName: "DB_PASSWORD",
  secretId: "secret-1",
  environmentId: "env-1",
  rotationId: "rotation-1",
  state: "enforced",
  evidence: [
    {
      producer: "gateway-1",
      workerClass: "postgres",
      hostId: null,
      hostName: null,
      status: "acknowledged",
      evidence: [
        { kind: "session_closed", count: 3 },
        { kind: "cache_cleared", count: 1 },
      ],
    },
  ],
};

const REMOVED_PAYLOAD = {
  kind: "team_member_removed",
  environmentId: "env-1",
  teamName: "Acme",
  memberName: "Sam",
  hosts: [
    {
      hostId: "host-1",
      hostName: "Build host",
      stopped: "done",
      credentialClosed: "done",
      replacementDelivered: "done",
    },
    {
      hostId: "host-2",
      hostName: "Dev host",
      stopped: "done",
      credentialClosed: "pending",
      replacementDelivered: "pending",
    },
    {
      hostId: "host-3",
      hostName: "CI host",
      stopped: "done",
      credentialClosed: "done",
      replacementDelivered: "done",
    },
  ],
};

const JOINED_PAYLOAD = {
  kind: "team_member_joined",
  environmentId: "env-1",
  teamName: "Acme",
  memberName: "Sam",
  toNewcomer: false,
};

const UNAPPLIED_PAYLOAD = {
  kind: "team_policy_unapplied",
  environmentId: "env-1",
  teamName: "Acme",
  policyVersion: 3,
};

const EXPIRED_PAYLOAD = {
  kind: "team_policy_authority_expired",
  environmentId: "env-1",
  teamName: "Acme",
  hostId: "host-1",
  hostName: "Build host",
};

const ADMIN_GONE_PAYLOAD = {
  kind: "team_installing_admin_gone",
  environmentId: "env-1",
  teamName: "Acme",
  adminName: "Sam",
  reason: "left",
};

const UNLINKED_PAYLOAD = {
  kind: "team_plan_unlinked",
  environmentId: "env-1",
  teamName: "Acme",
};

const PODS_FULL_PAYLOAD = {
  kind: "team_pods_full",
  environmentId: "env-1",
  teamName: "Acme",
  podCount: 4,
};

const NEW_PAYLOADS: Readonly<Record<NewKind, Record<string, unknown>>> = {
  "secret.rotated": ROTATED_PAYLOAD,
  "team.member.removed": REMOVED_PAYLOAD,
  "team.member.joined": JOINED_PAYLOAD,
  "team.policy.unapplied": UNAPPLIED_PAYLOAD,
  "team.policy.authority_expired": EXPIRED_PAYLOAD,
  "team.installing_admin.gone": ADMIN_GONE_PAYLOAD,
  "team.plan.unlinked": UNLINKED_PAYLOAD,
  "team.pods.full": PODS_FULL_PAYLOAD,
};

/** A full valid entry per new kind, on the arm's own severity and outcome. */
function fullEntry(kind: NewKind): Record<string, unknown> {
  return {
    ...ENTRY_BASE,
    kind,
    severity: kind === "secret.rotated" ? "done" : "info",
    outcome: "completed",
    payload: NEW_PAYLOADS[kind],
  };
}

function rotatedEntry(payload: Record<string, unknown>) {
  return hostNotificationEntrySchemaV23.parse({
    ...fullEntry("secret.rotated"),
    payload,
  });
}

function teamEntry(kind: NewKind, payload: Record<string, unknown>) {
  return hostNotificationEntrySchemaV23.parse({
    ...fullEntry(kind),
    payload,
  });
}

function producer(
  status: string,
  evidence: ReadonlyArray<{ kind: string; count: number | null }> | null,
) {
  return {
    producer: "gateway-1",
    workerClass: "postgres",
    hostId: null,
    hostName: null,
    status,
    evidence,
  };
}

describe("visibility of secret.rotated and the team kinds", () => {
  it.each([
    ["list 2.2", LIST, { major: 2, minor: 2 }],
    ["feed 1.3", FEED, { major: 1, minor: 3 }],
    ["cloudFeed 1.2", CLOUD_FEED, { major: 1, minor: 2 }],
  ])("hides all eight kinds at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    const hidden = hiddenHostNotificationKinds(surface, version);
    for (const kind of NEW_KINDS) {
      expect(visible).not.toContain(kind);
      expect(hidden).toContain(kind);
    }
  });

  it.each([
    ["list 2.3", LIST, { major: 2, minor: 3 }],
    ["feed 1.4", FEED, { major: 1, minor: 4 }],
    ["cloudFeed 1.3", CLOUD_FEED, { major: 1, minor: 3 }],
  ])("shows all eight kinds at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    const hidden = hiddenHostNotificationKinds(surface, version);
    for (const kind of NEW_KINDS) {
      expect(visible).toContain(kind);
      expect(hidden).not.toContain(kind);
    }
  });
});

describe("entry schemas for secret.rotated and the team kinds", () => {
  it.each(NEW_KINDS)("V23 parses a full %s entry", (kind) => {
    const parsed = hostNotificationEntrySchemaV23.safeParse(fullEntry(kind));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe(kind);
  });

  it.each(NEW_KINDS)("V22 rejects a full %s entry", (kind) => {
    expect(
      hostNotificationEntrySchemaV22.safeParse(fullEntry(kind)).success,
    ).toBe(false);
  });

  it("accepts secret.rotated with an errored outcome and rejects any other", () => {
    const base = fullEntry("secret.rotated");
    expect(
      hostNotificationEntrySchemaV23.safeParse({
        ...base,
        severity: "failure",
        outcome: "errored",
      }).success,
    ).toBe(true);
    expect(
      hostNotificationEntrySchemaV23.safeParse({ ...base, outcome: "stopped" })
        .success,
    ).toBe(false);
    expect(
      hostNotificationEntrySchemaV23.safeParse({ ...base, outcome: null })
        .success,
    ).toBe(false);
  });

  it.each(NEW_KINDS)("%s carries no resolvedAt", (kind) => {
    const parsed = hostNotificationEntrySchemaV23.parse(fullEntry(kind));
    expect("resolvedAt" in parsed).toBe(false);
  });
});

describe("payload tolerance", () => {
  it("parses a secret.rotated payload with an unknown evidence kind, producer status and state", () => {
    const parsed = parseKnownHostNotificationPayloadForKind("secret.rotated", {
      ...ROTATED_PAYLOAD,
      state: "quiescing",
      evidence: [
        producer("sealed_by_vendor", [{ kind: "socket_reset", count: 2 }]),
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("secret_rotated");
  });

  it("keeps a producer's null evidence and a null evidence count", () => {
    const parsed = parseKnownHostNotificationPayloadForKind("secret.rotated", {
      ...ROTATED_PAYLOAD,
      evidence: [
        producer("contained_by_expiry", null),
        producer("acknowledged", [{ kind: "session_closed", count: null }]),
      ],
    });
    expect(parsed).not.toBeNull();
  });

  it("returns null when the payload kind does not match the notification kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "team.pods.full",
        ROTATED_PAYLOAD,
      ),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind(
        "secret.rotated",
        PODS_FULL_PAYLOAD,
      ),
    ).toBeNull();
  });

  it.each(NEW_KINDS)(
    "%s payload parses under its own kind and tolerates extra keys",
    (kind) => {
      const payload = NEW_PAYLOADS[kind];
      expect(
        parseKnownHostNotificationPayloadForKind(kind, payload),
      ).not.toBeNull();
      expect(
        parseKnownHostNotificationPayloadForKind(kind, {
          ...payload,
          addedByANewerHost: { anything: true },
        }),
      ).not.toBeNull();
    },
  );
});

describe("secret.rotated presentation", () => {
  const SUBJECT = "DB_PASSWORD";

  it("words an enforced rotation from the known evidence", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry(ROTATED_PAYLOAD),
    );
    expect(presentation.title).toBe("Secret value replaced");
    expect(presentation.body).toBe(
      `${SUBJECT} • Enforced: 3 sessions closed, cached keys dropped`,
    );
  });

  it("says Enforced alone when only unknown evidence was reported", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry({
        ...ROTATED_PAYLOAD,
        evidence: [
          producer("acknowledged", [{ kind: "socket_reset", count: 2 }]),
        ],
      }),
    );
    expect(presentation.body).toBe(`${SUBJECT} • Enforced`);
  });

  it("adds nothing for an unknown evidence kind beside a known one", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry({
        ...ROTATED_PAYLOAD,
        evidence: [
          producer("acknowledged", [
            { kind: "session_closed", count: 1 },
            { kind: "socket_reset", count: 2 },
          ]),
        ],
      }),
    );
    expect(presentation.body).toBe(`${SUBJECT} • Enforced: 1 session closed`);
  });

  it("adds nothing for a producer contained by expiry with no receipt", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry({
        ...ROTATED_PAYLOAD,
        evidence: [producer("contained_by_expiry", null)],
      }),
    );
    expect(presentation.body).toBe(`${SUBJECT} • Enforced`);
  });

  it("sums session counts over every producer", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry({
        ...ROTATED_PAYLOAD,
        evidence: [
          producer("acknowledged", [{ kind: "session_closed", count: 2 }]),
          producer("acknowledged", [
            { kind: "session_closed", count: 3 },
            { kind: "probe_refused", count: 1 },
          ]),
        ],
      }),
    );
    expect(presentation.body).toBe(
      `${SUBJECT} • Enforced: 5 sessions closed, old value refused`,
    );
  });

  it("reads Value replaced for a state this build does not know", () => {
    const presentation = formatHostNotificationPresentation(
      rotatedEntry({ ...ROTATED_PAYLOAD, state: "quiescing" }),
    );
    expect(presentation.body).toBe(`${SUBJECT} • Value replaced`);
  });

  it("words the stalled, failed, accepted and enforcing states", () => {
    const body = (state: string): string =>
      formatHostNotificationPresentation(
        rotatedEntry({ ...ROTATED_PAYLOAD, state, evidence: [] }),
      ).body;
    expect(body("stalled")).toBe(
      `${SUBJECT} • Not confirmed after a minute; you can stop the sandbox`,
    );
    expect(body("failed")).toBe(`${SUBJECT} • Replacing the value failed`);
    expect(body("accepted")).toBe(
      `${SUBJECT} • New value accepted, closing old sessions`,
    );
    expect(body("enforcing")).toBe(
      `${SUBJECT} • New value accepted, closing old sessions`,
    );
  });

  it("falls back to generic copy for a malformed payload without throwing", () => {
    const entry = rotatedEntry({ kind: "secret_rotated", secretName: "" });
    expect(() => formatHostNotificationPresentation(entry)).not.toThrow();
    expect(formatHostNotificationPresentation(entry)).toEqual({
      title: "Secret value replaced",
      body: "A secret • Value replaced",
    });
  });
});

describe("team notification presentation", () => {
  it("words a removal by how many hosts finished", () => {
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.member.removed", REMOVED_PAYLOAD),
      ),
    ).toEqual({
      title: "Member removed",
      body: "Sam • Acme • 2 of 3 hosts done",
    });
  });

  it("says the removal is complete when no host was involved", () => {
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.member.removed", { ...REMOVED_PAYLOAD, hosts: [] }),
      ).body,
    ).toBe("Sam • Acme • Removal complete");
  });

  it("tells the admins who joined and tells the newcomer where to start", () => {
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.member.joined", JOINED_PAYLOAD),
      ),
    ).toEqual({ title: "Member joined", body: "Sam • Joined Acme" });
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.member.joined", {
          ...JOINED_PAYLOAD,
          toNewcomer: true,
        }),
      ),
    ).toEqual({
      title: "Welcome to Acme",
      body: "Open a tab on one of Acme's sandboxes, or create one",
    });
  });

  it("words the policy, plan and pod rows", () => {
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.policy.unapplied", UNAPPLIED_PAYLOAD),
      ),
    ).toEqual({
      title: "Policy not applied yet",
      body: "Acme • No host has applied the latest policy yet",
    });
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.policy.authority_expired", EXPIRED_PAYLOAD),
      ),
    ).toEqual({
      title: "Policy lapsed on a host",
      body: "Build host • Its Acme policy has lapsed",
    });
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.plan.unlinked", UNLINKED_PAYLOAD),
      ),
    ).toEqual({
      title: "Team plan unlinked",
      body: "Acme • Its plan was unlinked",
    });
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.pods.full", PODS_FULL_PAYLOAD),
      ),
    ).toEqual({
      title: "Every pod is full",
      body: "Acme • All 4 pods are full; add a pod",
    });
  });

  it.each([
    ["left", "Sam left Acme"],
    ["demoted", "Sam is no longer an admin of Acme"],
    ["unlinked", "Sam unlinked GitHub"],
    ["retired", "Sam can no longer install GitHub for Acme"],
  ])("words the installing admin gone for reason %s", (reason, line) => {
    expect(
      formatHostNotificationPresentation(
        teamEntry("team.installing_admin.gone", {
          ...ADMIN_GONE_PAYLOAD,
          reason,
        }),
      ),
    ).toEqual({
      title: "GitHub needs an installing admin",
      body: `${line} • Git fails on every Acme sandbox until another admin connects GitHub`,
    });
  });

  it.each([
    ["team.member.removed", "Member removed", "A team member was removed"],
    ["team.member.joined", "Member joined", "Someone joined your team"],
    [
      "team.policy.unapplied",
      "Policy not applied yet",
      "No host has applied the latest policy yet",
    ],
    [
      "team.policy.authority_expired",
      "Policy lapsed on a host",
      "A host's team policy has lapsed",
    ],
    [
      "team.installing_admin.gone",
      "GitHub needs an installing admin",
      "Git fails on every team sandbox until another admin connects GitHub",
    ],
    ["team.plan.unlinked", "Team plan unlinked", "A team's plan was unlinked"],
    [
      "team.pods.full",
      "Every pod is full",
      "Every team pod is full; add a pod",
    ],
  ] as const)(
    "%s falls back to generic copy for a malformed payload",
    (kind, title, body) => {
      const entry = teamEntry(kind, { unexpected: true });
      expect(() => formatHostNotificationPresentation(entry)).not.toThrow();
      expect(formatHostNotificationPresentation(entry)).toEqual({
        title,
        body,
      });
    },
  );
});

describe("secret_grant_request environmentId", () => {
  const BASE = {
    kind: "secret_grant_request",
    requestId: "request-1",
    hostId: "host-1",
    secretName: "DB_PASSWORD",
    destination: "db.example.com",
    port: 3306,
    protocol: "mysql",
    reason: "Run the migration",
  };

  it("parses with a null environmentId", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse({
      ...BASE,
      environmentId: null,
    });
    expect(parsed.environmentId).toBeNull();
  });

  it("parses with an environmentId", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse({
      ...BASE,
      environmentId: "env-1",
    });
    expect(parsed.environmentId).toBe("env-1");
  });

  it("parses with the environmentId left out", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse(BASE);
    expect(parsed.environmentId).toBeUndefined();
  });
});

describe("secret_grant_request team and decision fields", () => {
  const BASE = {
    kind: "secret_grant_request",
    requestId: "request-1",
    hostId: "host-1",
    secretName: "DB_PASSWORD",
    destination: "db.example.com",
    port: 3306,
    protocol: "mysql",
    reason: "Run the migration",
    environmentId: "env-team-1",
  };

  it("parses with teamName, decision and decidedBy", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse({
      ...BASE,
      teamName: "Acme",
      decision: "approved",
      decidedBy: "Ana",
    });
    expect(parsed.teamName).toBe("Acme");
    expect(parsed.decision).toBe("approved");
    expect(parsed.decidedBy).toBe("Ana");
  });

  it("parses with the three fields null", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse({
      ...BASE,
      teamName: null,
      decision: null,
      decidedBy: null,
    });
    expect(parsed.teamName).toBeNull();
    expect(parsed.decision).toBeNull();
    expect(parsed.decidedBy).toBeNull();
  });

  it("parses with the three fields left out", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse(BASE);
    expect(parsed.teamName).toBeUndefined();
    expect(parsed.decision).toBeUndefined();
    expect(parsed.decidedBy).toBeUndefined();
  });

  it("keeps a decision this build does not list", () => {
    const parsed = hostNotificationSecretGrantRequestPayloadSchema.parse({
      ...BASE,
      decision: "revoked",
    });
    expect(parsed.decision).toBe("revoked");
  });

  it("refuses an empty decidedBy", () => {
    expect(
      hostNotificationSecretGrantRequestPayloadSchema.safeParse({
        ...BASE,
        decidedBy: "",
      }).success,
    ).toBe(false);
  });

  it("parses under its own kind, fields included", () => {
    const parsed = parseKnownHostNotificationPayloadForKind(
      "secret.grant.requested",
      { ...BASE, teamName: "Acme", decision: "declined", decidedBy: "Ana" },
    );
    expect(parsed).toMatchObject({
      kind: "secret_grant_request",
      teamName: "Acme",
      decision: "declined",
      decidedBy: "Ana",
    });
  });
});

describe("secret.grant.requested presentation of a resolved row", () => {
  const PAYLOAD = {
    kind: "secret_grant_request",
    requestId: "request-1",
    hostId: "host-1",
    secretName: "DB_PASSWORD",
    destination: "db.example.com",
    port: 3306,
    protocol: "mysql",
    reason: "Run the migration",
    environmentId: "env-team-1",
    teamName: "Acme",
  };

  function grantEntry(
    resolvedAt: number | null,
    payload: Record<string, unknown>,
  ) {
    return hostNotificationEntrySchemaV23.parse({
      ...ENTRY_BASE,
      kind: "secret.grant.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt,
      payload,
    });
  }

  it("reads Approved by Ana when the payload names her as the approver", () => {
    const presentation = formatHostNotificationPresentation(
      grantEntry(1_700_000_000_500, {
        ...PAYLOAD,
        decision: "approved",
        decidedBy: "Ana",
      }),
    );
    expect(presentation.title).toBe("Secret requested");
    expect(presentation.body).toBe("DB_PASSWORD • Approved by Ana");
  });

  it("reads Declined by Ana when the payload names her as the decliner", () => {
    expect(
      formatHostNotificationPresentation(
        grantEntry(1_700_000_000_500, {
          ...PAYLOAD,
          decision: "declined",
          decidedBy: "Ana",
        }),
      ).body,
    ).toBe("DB_PASSWORD • Declined by Ana");
  });

  it.each([
    ["no decision or name", {}],
    ["a name but no decision", { decidedBy: "Ana" }],
    ["a decision but no name", { decision: "approved" }],
    ["a null name", { decision: "approved", decidedBy: null }],
    ["an expiry", { decision: "expired", decidedBy: "Ana" }],
    [
      "a decision this build does not know",
      { decision: "revoked", decidedBy: "Ana" },
    ],
  ])("reads Decided when the payload carries %s", (_name, fields) => {
    expect(
      formatHostNotificationPresentation(
        grantEntry(1_700_000_000_500, { ...PAYLOAD, ...fields }),
      ).body,
    ).toBe("DB_PASSWORD • Decided");
  });

  it("still waits for a decision while the row is open, whatever the payload names", () => {
    expect(
      formatHostNotificationPresentation(
        grantEntry(null, {
          ...PAYLOAD,
          decision: "approved",
          decidedBy: "Ana",
        }),
      ).body,
    ).toBe("DB_PASSWORD • Waiting for your decision");
  });
});

describe("sandbox grant rotation", () => {
  const GRANT = {
    secretName: "DB_PASSWORD",
    kind: "password",
    protocol: "mysql",
    mode: "brokered",
    source: "default",
  };

  it("defaults rotation to null when the broker does not report it", () => {
    const parsed = sandboxGrantSchema.parse(GRANT);
    expect(parsed.rotation).toBeNull();
  });

  it("parses a rotation whose class evidence has an unknown kind", () => {
    const parsed = sandboxGrantSchema.parse({
      ...GRANT,
      rotation: {
        state: "reticulating",
        classes: [
          {
            workerClass: "postgres",
            status: "sealed_by_vendor",
            evidence: [
              { kind: "session_closed", count: 3 },
              { kind: "socket_reset", count: 2 },
            ],
          },
          { workerClass: "mysql", status: "missing", evidence: null },
        ],
      },
    });
    expect(parsed.rotation?.state).toBe("reticulating");
    expect(parsed.rotation?.classes).toHaveLength(2);
    expect(parsed.rotation?.classes[0]?.evidence?.[1]?.kind).toBe(
      "socket_reset",
    );
    expect(parsed.rotation?.classes[1]?.evidence).toBeNull();
  });

  it("defaults a rotation's classes to empty", () => {
    const parsed = sandboxGrantSchema.parse({
      ...GRANT,
      rotation: { state: "accepted" },
    });
    expect(parsed.rotation?.classes).toEqual([]);
  });
});

describe("new RPC error codes", () => {
  it.each([
    "team_secrets_are_brokered",
    "version_destroyed",
    "version_current",
  ])("lists %s", (code) => {
    expect(RPC_ERROR_CODES).toContain(code);
  });
});
