import { describe, expect, it } from "vitest";
import {
  isOutcomeSettled,
  profileCopyDraftPollActivity,
  profileCopyIncomingPollActivity,
  profileCopyOperationRows,
  profileCopyOutcomesPollActivity,
  profileCopySourceRecovery,
  PROFILE_COPY_DISPOSITIONS,
  PROFILE_COPY_MANUAL_ROUTES,
  PROFILE_COPY_PROVIDERS,
  PROFILE_COPY_REASONS,
  PROFILE_COPY_STATES,
  type ProfileCopyPreviewRecord,
} from "@/lib/profile-copy/profile-copy-model";
import {
  profileCopyFeasibilitySchema,
  profileCopyOutcomeSchema,
  profileCopyPreviewDestinationSchema,
  profileCopyProviderSchema,
  profileCopyReasonSchema,
} from "@traycer/protocol/host/profile-copy-schemas";
import {
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  incomingDraft,
  previewRecord,
  profileCopyAttempt,
  profileCopyOutcome,
  recordedOutcome,
  TARGET_PROFILE_ID,
} from "./profile-copy-test-fixtures";

describe("isOutcomeSettled", () => {
  it("treats a source-local failed row as not settled", () => {
    expect(
      isOutcomeSettled(profileCopyOutcome({ state: "failed", reason: null })),
    ).toBe(false);
  });

  it("treats a recorded failed row as settled", () => {
    expect(
      isOutcomeSettled(recordedOutcome({ state: "failed", reason: null })),
    ).toBe(true);
  });

  it("treats a source-local blocked row as settled", () => {
    expect(
      isOutcomeSettled(
        profileCopyOutcome({ state: "blocked", reason: "unreachable" }),
      ),
    ).toBe(true);
  });

  it("treats a recorded blocked row as not settled", () => {
    expect(
      isOutcomeSettled(
        recordedOutcome({ state: "blocked", reason: "unsupported-auth" }),
      ),
    ).toBe(false);
  });

  it("settles the six destination-final states regardless of recording", () => {
    const finals = [
      "signed-in",
      "used-without-verification",
      "already-present",
      "cancelled",
      "quarantined",
      "removed",
    ] as const;
    for (const state of finals) {
      expect(isOutcomeSettled(profileCopyOutcome({ state }))).toBe(true);
      expect(isOutcomeSettled(recordedOutcome({ state }))).toBe(true);
    }
  });
});

describe("profileCopySourceRecovery", () => {
  it("offers nothing once a replacement attempt exists", () => {
    expect(
      profileCopySourceRecovery(
        recordedOutcome({
          state: "quarantined",
          replacementAttemptId: TARGET_PROFILE_ID,
        }),
        false,
      ),
    ).toBe("none");
  });

  it("retries a recorded quarantined row unless this window cancelled", () => {
    const quarantined = recordedOutcome({ state: "quarantined" });
    expect(profileCopySourceRecovery(quarantined, false)).toBe("retry");
    expect(profileCopySourceRecovery(quarantined, true)).toBe("copy-again");
  });

  it("retries a recorded cancelled row unless this window cancelled", () => {
    const cancelled = recordedOutcome({
      state: "cancelled",
      reason: "cancelled",
    });
    expect(profileCopySourceRecovery(cancelled, false)).toBe("retry");
    expect(profileCopySourceRecovery(cancelled, true)).toBe("copy-again");
  });

  it("copies again for a local cancelled row", () => {
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({ state: "cancelled", reason: "cancelled" }),
        false,
      ),
    ).toBe("copy-again");
  });

  it("copies again for recorded removed and recorded failed", () => {
    expect(
      profileCopySourceRecovery(recordedOutcome({ state: "removed" }), false),
    ).toBe("copy-again");
    expect(
      profileCopySourceRecovery(recordedOutcome({ state: "failed" }), false),
    ).toBe("copy-again");
  });

  it("retries a transient local block and copies again for profile-level blocks", () => {
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({ state: "blocked", reason: "unreachable" }),
        false,
      ),
    ).toBe("retry");
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({ state: "blocked", reason: "source-changed" }),
        false,
      ),
    ).toBe("copy-again");
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({
          state: "blocked",
          reason: "credential-missing",
        }),
        false,
      ),
    ).toBe("copy-again");
  });

  it("offers copy-again for a retryable local block after this window cancelled", () => {
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({ state: "blocked", reason: "unreachable" }),
        true,
      ),
    ).toBe("copy-again");
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({
          state: "blocked",
          reason: "adapter-not-admitted",
        }),
        true,
      ),
    ).toBe("none");
  });

  it("offers nothing for a closed-route local block", () => {
    expect(
      profileCopySourceRecovery(
        profileCopyOutcome({
          state: "blocked",
          reason: "adapter-not-admitted",
        }),
        false,
      ),
    ).toBe("none");
  });
});

describe("poll-activity classifiers", () => {
  it("marks preparing, verifying, ready and local failed as active", () => {
    for (const state of [
      "preparing",
      "verifying",
      "ready",
      "failed",
    ] as const) {
      expect(
        profileCopyOutcomesPollActivity([profileCopyOutcome({ state })]),
      ).toBe("active");
    }
  });

  it("marks sign-in-required as waiting and signed-in as idle", () => {
    expect(
      profileCopyOutcomesPollActivity([
        recordedOutcome({ state: "sign-in-required" }),
      ]),
    ).toBe("waiting");
    expect(
      profileCopyOutcomesPollActivity([
        recordedOutcome({ state: "signed-in" }),
      ]),
    ).toBe("idle");
  });

  it("prefers active over waiting when mixed heads are present", () => {
    expect(
      profileCopyOutcomesPollActivity([
        recordedOutcome({ state: "sign-in-required" }),
        profileCopyOutcome({ state: "preparing" }),
      ]),
    ).toBe("active");
  });

  it("polls a destination draft only while the host is working or signing in", () => {
    expect(
      profileCopyDraftPollActivity(recordedOutcome({ state: "preparing" })),
    ).toBe("active");
    expect(
      profileCopyDraftPollActivity(recordedOutcome({ state: "signing-in" })),
    ).toBe("waiting");
    expect(
      profileCopyDraftPollActivity(
        recordedOutcome({ state: "sign-in-required" }),
      ),
    ).toBe("idle");
  });

  it("polls incoming on the waiting lane while any draft is transient", () => {
    expect(
      profileCopyIncomingPollActivity([
        incomingDraft({ outcome: recordedOutcome({ state: "preparing" }) }),
      ]),
    ).toBe("waiting");
    expect(
      profileCopyIncomingPollActivity([
        incomingDraft({ outcome: recordedOutcome({ state: "quarantined" }) }),
      ]),
    ).toBe("idle");
  });
});

describe("profileCopyOperationRows", () => {
  const automatic: ProfileCopyPreviewRecord = previewRecord({
    destinationHostId: DEST_HOST_ID,
    disposition: "automatic",
  });
  const unavailable: ProfileCopyPreviewRecord = previewRecord({
    destinationHostId: DEST_HOST_TWO_ID,
    disposition: "unavailable",
    reason: "update-required",
  });

  it("keeps listed destination order", () => {
    const rows = profileCopyOperationRows(
      [DEST_HOST_TWO_ID, DEST_HOST_ID],
      [automatic, unavailable],
      null,
    );
    expect(rows.map((row) => row.destinationHostId)).toEqual([
      DEST_HOST_TWO_ID,
      DEST_HOST_ID,
    ]);
  });

  it("renders a non-routable destination as preview-only when no attempt exists", () => {
    const rows = profileCopyOperationRows(
      [DEST_HOST_TWO_ID],
      [unavailable],
      [],
    );
    expect(rows).toEqual([
      {
        kind: "preview-only",
        destinationHostId: DEST_HOST_TWO_ID,
        preview: unavailable,
      },
    ]);
  });

  it("renders a routable destination without an outcome as unreported", () => {
    const rows = profileCopyOperationRows([DEST_HOST_ID], [automatic], []);
    expect(rows).toEqual([
      { kind: "unreported", destinationHostId: DEST_HOST_ID },
    ]);
  });

  it("appends an unlisted destination the source reported", () => {
    const extra = recordedOutcome({
      attempt: profileCopyAttempt({ destinationHostId: "extra-host" }),
      state: "signed-in",
    });
    const rows = profileCopyOperationRows([DEST_HOST_ID], [automatic], [extra]);
    expect(rows.map((row) => row.destinationHostId)).toEqual([
      DEST_HOST_ID,
      "extra-host",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "attempt",
      destinationHostId: "extra-host",
      outcome: extra,
    });
  });

  // IDENTITY, not equality: zod 4 assigns an enum's `.options` once at
  // construction, so only a list that IS the schema's array passes. A
  // hand-written or copied list fails even while its values still match.
  it("lists every wire state and reason from the schema options", () => {
    expect(PROFILE_COPY_STATES).toBe(
      profileCopyOutcomeSchema.shape.state.options,
    );
    expect(PROFILE_COPY_REASONS).toBe(profileCopyReasonSchema.options);
  });

  it("lists every wire provider, disposition and manual route from the schema options", () => {
    expect(PROFILE_COPY_PROVIDERS).toBe(profileCopyProviderSchema.options);
    expect(PROFILE_COPY_DISPOSITIONS).toBe(
      profileCopyPreviewDestinationSchema.shape.disposition.options,
    );
    expect(PROFILE_COPY_MANUAL_ROUTES).toBe(
      profileCopyFeasibilitySchema.shape.manual.options[0].shape.route.options,
    );
  });
});
