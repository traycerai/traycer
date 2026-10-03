import { describe, expect, it } from "vitest";
import {
  PROFILE_SYNC_MAX_BATCHES,
  PROFILE_SYNC_MAX_RULES,
  profileSyncBatchSchema,
  profileSyncItemSchema,
  profileSyncListSchema,
  profileSyncPreviewSchema,
  profileSyncRuleSchema,
  type ProfileSyncBatch,
  type ProfileSyncItem,
  type ProfileSyncRule,
} from "../profile-sync-schemas";

const SOURCE_HOST = "source-host";
const DEST_HOST = "dest-host";
const SOURCE_PROFILE = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const REVISION = "a".repeat(64);

function uuid(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function item(): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: SOURCE_PROFILE,
    name: "Work",
    destinationHostId: DEST_HOST,
    operationId: OPERATION_ID,
    preview: {
      source: {
        sourceHostId: SOURCE_HOST,
        sourceProfileId: SOURCE_PROFILE,
        providerId: "claude",
      },
      previewRevision: REVISION,
      destinations: [
        {
          destinationHostId: DEST_HOST,
          feasibility: {
            automatic: {
              status: "available",
              admissionRevision: "b".repeat(64),
            },
            manual: {
              status: "unavailable",
              reason: "manual-login-unavailable",
            },
          },
          disposition: "automatic",
          reason: null,
          existingProfileId: null,
          destinationProviderEnabled: true,
        },
      ],
    },
    outcome: {
      attempt: {
        sourceHostId: SOURCE_HOST,
        sourceProfileId: SOURCE_PROFILE,
        providerId: "claude",
        operationId: OPERATION_ID,
        attemptId: ATTEMPT_ID,
        destinationHostId: DEST_HOST,
      },
      revision: 1,
      state: "preparing",
      reason: null,
      targetProfileId: null,
      targetEnabled: null,
      targetAuthStatus: null,
      replacementAttemptId: null,
      desiredEnabled: true,
      destinationProviderEnabled: true,
      readiness: {
        preparation: "incomplete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    },
    state: "copying",
    sourceSettings: { name: "Work", color: "#ef4444", enabled: true },
    sourceIdentityStamp: "c".repeat(64),
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

interface ItemIdentity {
  readonly providerId?: ProfileSyncItem["providerId"];
  readonly sourceProfileId?: string;
  readonly destinationHostId?: string;
  readonly operationId?: string;
  readonly attemptId?: string;
}

/** Fresh attempt ids for constructed fixtures, as production mints one per attempt. */
let nextAttempt = 1000;
function freshAttemptId(): string {
  nextAttempt += 1;
  return uuid(nextAttempt);
}

/** The base item with the given identity applied consistently everywhere. */
function itemWith(identity: ItemIdentity): ProfileSyncItem {
  const base = item();
  if (base.preview === null || base.outcome === null)
    throw new Error("fixture has a preview and an outcome");
  const providerId = identity.providerId ?? base.providerId;
  const sourceProfileId = identity.sourceProfileId ?? base.sourceProfileId;
  const destinationHostId =
    identity.destinationHostId ?? base.destinationHostId;
  const operationId = identity.operationId ?? base.operationId;
  const attemptId = identity.attemptId ?? freshAttemptId();
  return {
    ...base,
    providerId,
    sourceProfileId,
    destinationHostId,
    operationId,
    preview: {
      ...base.preview,
      source: { ...base.preview.source, providerId, sourceProfileId },
      destinations: base.preview.destinations.map((entry) => ({
        ...entry,
        destinationHostId,
      })),
    },
    outcome: {
      ...base.outcome,
      attempt: {
        ...base.outcome.attempt,
        providerId,
        sourceProfileId,
        destinationHostId,
        operationId,
        attemptId,
      },
    },
  };
}

function withAttempt(
  overrides: Partial<NonNullable<ProfileSyncItem["outcome"]>["attempt"]>,
): ProfileSyncItem {
  const base = item();
  if (base.outcome === null) throw new Error("fixture has an outcome");
  return {
    ...base,
    outcome: {
      ...base.outcome,
      attempt: { ...base.outcome.attempt, ...overrides },
    },
  };
}

function batch(
  sourceHostId: string,
  items: ProfileSyncItem[],
): ProfileSyncBatch {
  return {
    batchId: uuid(1),
    sourceHostId,
    createdAt: 1,
    automatic: false,
    items,
  };
}

function rule(n: number): ProfileSyncRule {
  return {
    ruleId: uuid(n),
    sourceHostId: SOURCE_HOST,
    destinationHostId: `dest-${String(n)}`,
    scope: { kind: "all" },
    paused: false,
    revision: 1,
    lastCheckedAt: null,
    batchId: null,
    status: "waiting",
  };
}

describe("profile sync item consistency", () => {
  it("accepts an item whose preview and outcome describe the same transfer", () => {
    expect(profileSyncItemSchema.safeParse(item()).success).toBe(true);
  });

  it.each([
    ["provider", { providerId: "codex" as const }],
    [
      "source profile",
      { sourceProfileId: "00000000-0000-4000-8000-0000000000aa" },
    ],
    ["destination host", { destinationHostId: "another-dest" }],
    ["operation", { operationId: "00000000-0000-4000-8000-0000000000bb" }],
  ])("rejects a nested outcome with a different %s", (_label, override) => {
    expect(profileSyncItemSchema.safeParse(withAttempt(override)).success).toBe(
      false,
    );
  });
});

describe("profile sync needs-action receipt rule", () => {
  function receiptFree(
    state: ProfileSyncItem["state"],
    identityChanged: boolean,
  ): ProfileSyncItem {
    return { ...item(), state, outcome: null, identityChanged };
  }

  it("accepts needs-action carrying a matching outcome", () => {
    expect(
      profileSyncItemSchema.safeParse({
        ...item(),
        state: "needs-action",
        identityChanged: false,
      }).success,
    ).toBe(true);
  });

  it("rejects generic needs-action without an outcome, for a rule-specific reason", () => {
    const result = profileSyncItemSchema.safeParse(
      receiptFree("needs-action", false),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.code)).toEqual(["custom"]);
    // The same item is valid once it carries an outcome, so the outcome
    // is the only thing the rejection can be about.
    expect(
      profileSyncItemSchema.safeParse({
        ...receiptFree("needs-action", false),
        outcome: item().outcome,
      }).success,
    ).toBe(true);
  });

  it("accepts needs-action without an outcome when the source identity changed", () => {
    expect(
      profileSyncItemSchema.safeParse(receiptFree("needs-action", true))
        .success,
    ).toBe(true);
  });

  it("accepts needs-action with an outcome and a changed identity", () => {
    expect(
      profileSyncItemSchema.safeParse({
        ...item(),
        state: "needs-action",
        identityChanged: true,
      }).success,
    ).toBe(true);
  });

  it.each(["queued", "unconfirmed", "unavailable"] as const)(
    "keeps receipt-free %s items valid",
    (state) => {
      expect(
        profileSyncItemSchema.safeParse(receiptFree(state, false)).success,
      ).toBe(true);
    },
  );
});

describe("profile sync source consistency", () => {
  it("accepts a batch whose items belong to its source host", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item()])).success,
    ).toBe(true);
  });

  it("rejects a batch naming a different source host than its items", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch("other-host", [item()])).success,
    ).toBe(false);
  });

  it("accepts a preview whose selection source matches its items and rejects one that does not", () => {
    const selection = (sourceHostId: string) => ({
      sourceHostId,
      scope: { kind: "all" as const },
      destinationHostIds: [DEST_HOST],
    });
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: selection(SOURCE_HOST),
        revision: REVISION,
        items: [item()],
      }).success,
    ).toBe(true);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: selection("other-host"),
        revision: REVISION,
        items: [item()],
      }).success,
    ).toBe(false);
  });
});

describe("profile sync list bounds", () => {
  const batches = (count: number): ProfileSyncBatch[] =>
    Array.from({ length: count }, (_unused, index) => ({
      ...batch(SOURCE_HOST, []),
      batchId: uuid(index + 1),
    }));
  const rules = (count: number): ProfileSyncRule[] =>
    Array.from({ length: count }, (_unused, index) => rule(index + 1));

  it("pins the history limits the host document already enforces", () => {
    expect(PROFILE_SYNC_MAX_BATCHES).toBe(100);
    expect(PROFILE_SYNC_MAX_RULES).toBe(64);
  });

  it("accepts exactly the maximum number of batches and rules", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: batches(PROFILE_SYNC_MAX_BATCHES),
        rules: rules(PROFILE_SYNC_MAX_RULES),
      }).success,
    ).toBe(true);
  });

  it("rejects one batch or one rule over the maximum", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: batches(PROFILE_SYNC_MAX_BATCHES + 1),
        rules: [],
      }).success,
    ).toBe(false);
    expect(
      profileSyncListSchema.safeParse({
        batches: [],
        rules: rules(PROFILE_SYNC_MAX_RULES + 1),
      }).success,
    ).toBe(false);
  });
});

describe("profile sync operation uniqueness and self-targeted rules", () => {
  const ALT_OPERATION = "00000000-0000-4000-8000-0000000000cc";

  // A different PROFILE: legitimate second work for the same device.
  function distinctItem(): ProfileSyncItem {
    return itemWith({
      operationId: ALT_OPERATION,
      sourceProfileId: "00000000-0000-4000-8000-0000000000dd",
    });
  }

  it("accepts a batch and a preview whose items carry distinct operation ids", () => {
    expect(
      profileSyncBatchSchema.safeParse(
        batch(SOURCE_HOST, [item(), distinctItem()]),
      ).success,
    ).toBe(true);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: {
          sourceHostId: SOURCE_HOST,
          scope: { kind: "all" },
          destinationHostIds: [DEST_HOST],
        },
        revision: REVISION,
        items: [item(), distinctItem()],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate operation ids inside a batch and inside a preview, for different logical transfers", () => {
    // A different profile keeps the logical tuple distinct, so only the shared
    // operation id can be what refuses these.
    const sameOperation = itemWith({
      sourceProfileId: "00000000-0000-4000-8000-0000000000df",
    });
    expect(sameOperation.operationId).toBe(item().operationId);
    expect(
      profileSyncBatchSchema.safeParse(
        batch(SOURCE_HOST, [item(), sameOperation]),
      ).success,
    ).toBe(false);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: {
          sourceHostId: SOURCE_HOST,
          scope: { kind: "all" },
          destinationHostIds: [DEST_HOST],
        },
        revision: REVISION,
        items: [item(), sameOperation],
      }).success,
    ).toBe(false);
  });

  const previewOf = (items: ProfileSyncItem[]) => ({
    selection: {
      sourceHostId: SOURCE_HOST,
      scope: { kind: "all" as const },
      destinationHostIds: [DEST_HOST, "dest-2"],
    },
    revision: REVISION,
    items,
  });

  it("rejects the same provider, profile and destination twice even with distinct operation ids", () => {
    const twin = itemWith({ operationId: ALT_OPERATION });
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item(), twin]))
        .success,
    ).toBe(false);
    expect(
      profileSyncPreviewSchema.safeParse(previewOf([item(), twin])).success,
    ).toBe(false);
  });

  it("keeps legitimate work: another provider, profile or destination is accepted", () => {
    const variants = [
      itemWith({ operationId: ALT_OPERATION, providerId: "codex" }),
      itemWith({
        operationId: ALT_OPERATION,
        sourceProfileId: "00000000-0000-4000-8000-0000000000de",
      }),
      itemWith({ operationId: ALT_OPERATION, destinationHostId: "dest-2" }),
    ];
    for (const variant of variants) {
      expect(
        profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item(), variant]))
          .success,
      ).toBe(true);
      expect(
        profileSyncPreviewSchema.safeParse(previewOf([item(), variant]))
          .success,
      ).toBe(true);
    }
  });

  it("rejects a rule that targets its own source, alone and inside a list", () => {
    const selfTargeted: ProfileSyncRule = {
      ...rule(1),
      destinationHostId: SOURCE_HOST,
    };
    expect(profileSyncRuleSchema.safeParse(rule(1)).success).toBe(true);
    expect(profileSyncRuleSchema.safeParse(selfTargeted).success).toBe(false);
    expect(
      profileSyncListSchema.safeParse({ batches: [], rules: [selfTargeted] })
        .success,
    ).toBe(false);
  });
});

describe("profile sync list rule destinations", () => {
  it("rejects two rules with distinct ids that target the same destination", () => {
    const result = profileSyncListSchema.safeParse({
      batches: [],
      rules: [
        rule(1),
        { ...rule(2), destinationHostId: rule(1).destinationHostId },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.code)).toEqual(["custom"]);
  });

  it("accepts rules with distinct ids and distinct destinations", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: [],
        rules: [rule(1), rule(2)],
      }).success,
    ).toBe(true);
  });
});

describe("profile sync preview identity-change rule", () => {
  const previewOf = (items: ProfileSyncItem[]) => ({
    selection: {
      sourceHostId: SOURCE_HOST,
      scope: { kind: "all" as const },
      destinationHostIds: [DEST_HOST],
    },
    revision: REVISION,
    items,
  });
  const changed = (state: ProfileSyncItem["state"]): ProfileSyncItem => ({
    ...item(),
    state,
    identityChanged: true,
  });

  it.each(["ready", "synced", "queued", "copying"] as const)(
    "rejects a %s preview item whose source identity changed",
    (state) => {
      const result = profileSyncPreviewSchema.safeParse(
        previewOf([changed(state)]),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.map((issue) => issue.code)).toEqual([
        "custom",
      ]);
      // Unchanged identity in the same state is valid: identity is the reason.
      expect(
        profileSyncPreviewSchema.safeParse(
          previewOf([{ ...changed(state), identityChanged: false }]),
        ).success,
      ).toBe(true);
    },
  );

  it("accepts a changed-identity preview item that needs attention", () => {
    expect(
      profileSyncPreviewSchema.safeParse(
        previewOf([{ ...changed("needs-action"), outcome: null }]),
      ).success,
    ).toBe(true);
  });

  it("keeps a changed-identity synced item valid in batch history", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [changed("synced")]))
        .success,
    ).toBe(true);
    expect(profileSyncItemSchema.safeParse(changed("synced")).success).toBe(
      true,
    );
  });
});

describe("profile sync attempt id uniqueness", () => {
  const ALT_OPERATION = "00000000-0000-4000-8000-0000000000ee";
  const ALT_PROFILE = "00000000-0000-4000-8000-0000000000ef";
  const previewOf = (items: ProfileSyncItem[]) => ({
    selection: {
      sourceHostId: SOURCE_HOST,
      scope: { kind: "all" as const },
      destinationHostIds: [DEST_HOST],
    },
    revision: REVISION,
    items,
  });
  // Different operation, profile and tuple; only the attempt id is shared.
  const sharesAttempt = (): ProfileSyncItem =>
    itemWith({
      operationId: ALT_OPERATION,
      sourceProfileId: ALT_PROFILE,
      attemptId: ATTEMPT_ID,
    });
  const noOutcome = (
    operationId: string,
    profile: string,
  ): ProfileSyncItem => ({
    ...itemWith({ operationId, sourceProfileId: profile }),
    outcome: null,
    state: "queued",
  });

  it("rejects one attempt id on two items in a batch and in a preview", () => {
    expect(sharesAttempt().outcome?.attempt.attemptId).toBe(ATTEMPT_ID);
    expect(
      profileSyncBatchSchema.safeParse(
        batch(SOURCE_HOST, [item(), sharesAttempt()]),
      ).success,
    ).toBe(false);
    expect(
      profileSyncPreviewSchema.safeParse(previewOf([item(), sharesAttempt()]))
        .success,
    ).toBe(false);
  });

  it("accepts distinct attempt ids on distinct work", () => {
    const distinct = itemWith({
      operationId: ALT_OPERATION,
      sourceProfileId: ALT_PROFILE,
    });
    expect(distinct.outcome?.attempt.attemptId).not.toBe(ATTEMPT_ID);
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item(), distinct]))
        .success,
    ).toBe(true);
    expect(
      profileSyncPreviewSchema.safeParse(previewOf([item(), distinct])).success,
    ).toBe(true);
  });

  it("lets items without an outcome repeat the absent attempt", () => {
    const items = [
      noOutcome(ALT_OPERATION, ALT_PROFILE),
      noOutcome(uuid(7), uuid(8)),
    ];
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, items)).success,
    ).toBe(true);
    expect(profileSyncPreviewSchema.safeParse(previewOf(items)).success).toBe(
      true,
    );
  });

  it("lets separate history batches reuse one relationship receipt and operation", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: [
          batch(SOURCE_HOST, [item()]),
          { ...batch(SOURCE_HOST, [item()]), batchId: uuid(2) },
        ],
        rules: [],
      }).success,
    ).toBe(true);
  });
});

describe("profile sync epoch-millisecond timestamps", () => {
  const valid = [0, 1_700_000_000_000, Number.MAX_SAFE_INTEGER];
  const invalid = [
    ["negative", -1],
    ["fractional", 1_700_000_000_000.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["above the safe integer range", Number.MAX_SAFE_INTEGER + 1],
  ] as const;

  it.each(valid)("accepts %s as a batch createdAt", (createdAt) => {
    expect(
      profileSyncBatchSchema.safeParse({
        ...batch(SOURCE_HOST, []),
        createdAt,
      }).success,
    ).toBe(true);
  });

  it.each(invalid)("rejects a %s batch createdAt", (_label, createdAt) => {
    const result = profileSyncBatchSchema.safeParse({
      ...batch(SOURCE_HOST, []),
      createdAt,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["createdAt"],
    ]);
  });

  it.each([null, ...valid])("accepts %s as a rule lastCheckedAt", (value) => {
    expect(
      profileSyncRuleSchema.safeParse({ ...rule(1), lastCheckedAt: value })
        .success,
    ).toBe(true);
  });

  it.each(invalid)("rejects a %s rule lastCheckedAt", (_label, value) => {
    const result = profileSyncRuleSchema.safeParse({
      ...rule(1),
      lastCheckedAt: value,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["lastCheckedAt"],
    ]);
  });
});

describe("profile sync list identity and conflict contract", () => {
  const twin = (): ProfileSyncBatch => batch(SOURCE_HOST, []);

  it("rejects two batches sharing a batchId and two rules sharing a ruleId", () => {
    expect(
      profileSyncListSchema.safeParse({ batches: [twin(), twin()], rules: [] })
        .success,
    ).toBe(false);
    expect(
      profileSyncListSchema.safeParse({
        batches: [],
        rules: [rule(1), { ...rule(2), ruleId: rule(1).ruleId }],
      }).success,
    ).toBe(false);
  });

  it("accepts distinct batch and rule ids", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: [twin(), { ...twin(), batchId: uuid(2) }],
        rules: [rule(1), rule(2)],
      }).success,
    ).toBe(true);
  });

  it("requires destination settings on a conflict item", () => {
    const conflict = { ...item(), state: "conflict" as const };
    expect(
      profileSyncItemSchema.safeParse({
        ...conflict,
        destinationSettings: null,
      }).success,
    ).toBe(false);
    expect(
      profileSyncItemSchema.safeParse({
        ...conflict,
        destinationSettings: { name: "Other", color: "#10b981", enabled: true },
      }).success,
    ).toBe(true);
  });
});
