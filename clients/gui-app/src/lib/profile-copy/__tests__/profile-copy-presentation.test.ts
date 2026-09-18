import { describe, expect, it } from "vitest";
import {
  PROFILE_COPY_REASONS,
  PROFILE_COPY_STATES,
} from "@/lib/profile-copy/profile-copy-model";
import {
  isRouteClosedReason,
  isSharedResourceBlock,
  presentProfileCopyOutcome,
  presentProfileCopyPreview,
  profileCopyDirectBlockCopy,
  profileCopyDraftActions,
  profileCopyExistingProfileFacts,
  profileCopyReasonCopy,
  profileCopySharedResourceCopy,
  profileCopyStartRefusalCopy,
  startRefusalWithdrawsSignIn,
  type ProfileCopyDirectBlock,
  type ProfileCopyDraftActionContext,
  type ProfileCopyOutcomeContext,
} from "@/lib/profile-copy/profile-copy-presentation";
import {
  COPY_NAMES,
  DEST_HOST_ID,
  previewRecord,
  profileCopyOutcome,
  recordedOutcome,
} from "./profile-copy-test-fixtures";

const OUTCOME_CONTEXT: ProfileCopyOutcomeContext = {
  names: COPY_NAMES,
  route: "code-paste",
  cancelRequested: false,
};

const DRAFT_CONTEXT: ProfileCopyDraftActionContext = {
  destinationName: COPY_NAMES.destination,
  route: "code-paste",
  directBlock: null,
  startRefusal: null,
};

describe("presentProfileCopyOutcome", () => {
  it("renders a local failed row as Not sent yet", () => {
    const presentation = presentProfileCopyOutcome(
      profileCopyOutcome({ state: "failed" }),
      OUTCOME_CONTEXT,
    );
    expect(presentation.badge).toBe("Not sent yet");
    expect(presentation.tone).toBe("muted");
    expect(presentation.body).not.toMatch(/Failed/i);
  });

  it("renders a recorded failed row as Failed, never Not sent yet", () => {
    const presentation = presentProfileCopyOutcome(
      recordedOutcome({ state: "failed" }),
      OUTCOME_CONTEXT,
    );
    expect(presentation.badge).toBe("Failed");
    expect(presentation.tone).toBe("destructive");
    expect(presentation.body).toContain("failed");
    expect(presentation.badge).not.toBe("Not sent yet");
    expect(presentation.body).not.toMatch(/Not sent yet/i);
  });

  it("renders quarantined as Interrupted — retry required and never offers sign-in", () => {
    const outcome = recordedOutcome({
      state: "quarantined",
      reason: "writer-unconfirmed",
    });
    const presentation = presentProfileCopyOutcome(outcome, OUTCOME_CONTEXT);
    expect(presentation.badge).toBe("Interrupted — retry required");
    expect(presentation.tone).toBe("destructive");
    expect(presentation.body).not.toMatch(/Sign-in required/i);
    expect(profileCopyDraftActions(outcome, DRAFT_CONTEXT)).toEqual({
      primary: null,
      secondary: [],
    });
  });

  it("never labels used-without-verification as Signed in", () => {
    const presentation = presentProfileCopyOutcome(
      recordedOutcome({ state: "used-without-verification" }),
      OUTCOME_CONTEXT,
    );
    expect(presentation.badge).toBe("Added — not verified");
    expect(presentation.badge).not.toMatch(/Signed in/i);
    expect(presentation.body).not.toMatch(/Signed in/i);
  });

  it("produces non-empty copy for every wire state with no raw host id", () => {
    for (const state of PROFILE_COPY_STATES) {
      const presentation = presentProfileCopyOutcome(
        recordedOutcome({ state }),
        OUTCOME_CONTEXT,
      );
      expect(presentation.badge.length).toBeGreaterThan(0);
      expect(presentation.body.length).toBeGreaterThan(0);
      expect(presentation.badge).not.toContain(DEST_HOST_ID);
      expect(presentation.body).not.toContain(DEST_HOST_ID);
    }
  });
});

describe("profileCopyReasonCopy — unavailable routes", () => {
  it("names the device for adapter-not-admitted, manual-login-unavailable and destination-local-login-required", () => {
    for (const reason of [
      "adapter-not-admitted",
      "manual-login-unavailable",
      "destination-local-login-required",
    ] as const) {
      const copy = profileCopyReasonCopy(reason, COPY_NAMES);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.body).toContain(COPY_NAMES.destination);
      expect(copy.badge.toLowerCase()).not.toBe("unavailable");
      expect(copy.body).not.toMatch(/not supported yet, try later/i);
    }
  });

  it("produces non-empty copy for every wire reason including null", () => {
    for (const reason of [...PROFILE_COPY_REASONS, null]) {
      const copy = profileCopyReasonCopy(reason, COPY_NAMES);
      expect(copy.badge.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.badge).not.toContain(DEST_HOST_ID);
      expect(copy.body).not.toContain(DEST_HOST_ID);
    }
  });
});

describe("presentProfileCopyPreview", () => {
  it("surfaces unavailable reason text on every selected device", () => {
    const presentation = presentProfileCopyPreview(
      previewRecord({
        disposition: "unavailable",
        reason: "manual-login-unavailable",
      }),
      COPY_NAMES,
    );
    expect(presentation.body).toContain(COPY_NAMES.provider);
    expect(presentation.body).toContain(COPY_NAMES.destination);
    expect(presentation.badge.length).toBeGreaterThan(0);
  });
});

describe("profileCopyDraftActions", () => {
  it("withdraws Sign in when a route-closed sign-in block is recorded", () => {
    const outcome = recordedOutcome({ state: "sign-in-required" });
    const offered = profileCopyDraftActions(outcome, DRAFT_CONTEXT);
    expect(offered.primary?.kind).toBe("sign-in");
    const withdrawn = profileCopyDraftActions(outcome, {
      ...DRAFT_CONTEXT,
      directBlock: {
        verb: "sign-in",
        revision: 1,
        reason: "adapter-not-admitted",
        repeats: 1,
      },
    });
    expect(withdrawn.primary?.kind).toBe("cancel-draft");
    expect(withdrawn.secondary).toEqual([]);
  });

  it("never offers sign-in on an automatic route", () => {
    const actions = profileCopyDraftActions(
      recordedOutcome({ state: "sign-in-required" }),
      { ...DRAFT_CONTEXT, route: "automatic" },
    );
    expect(actions.primary?.kind).toBe("cancel-draft");
    expect(actions.secondary).toEqual([]);
  });

  it("offers cancel only when verify was refused for this revision", () => {
    const actions = profileCopyDraftActions(
      recordedOutcome({
        state: "verification-pending",
        readiness: {
          preparation: "complete",
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
      }),
      {
        ...DRAFT_CONTEXT,
        directBlock: {
          verb: "verify",
          revision: 1,
          reason: "unsupported-auth",
          repeats: 1,
        },
      },
    );
    expect(actions.primary?.kind).toBe("cancel-draft");
    expect(actions.secondary).toEqual([]);
  });

  it("offers Use without verification only for indeterminate with a revision", () => {
    const readiness = {
      preparation: "complete" as const,
      verification: "indeterminate" as const,
      verificationRevision: 4,
      acceptedVerificationRevision: null,
      identity: "not-checked" as const,
      identityRevision: null,
      acceptedIdentityRevision: null,
      writer: "none" as const,
      writerGeneration: 0,
      quarantined: false,
    };
    const withRevision = profileCopyDraftActions(
      recordedOutcome({ state: "verification-pending", readiness }),
      DRAFT_CONTEXT,
    );
    expect(withRevision.secondary.map((action) => action.kind)).toContain(
      "use-without-verification",
    );
    const withoutRevision = profileCopyDraftActions(
      recordedOutcome({
        state: "verification-pending",
        readiness: { ...readiness, verificationRevision: null },
      }),
      DRAFT_CONTEXT,
    );
    expect(
      withoutRevision.secondary.map((action) => action.kind),
    ).not.toContain("use-without-verification");
  });

  it("offers Keep this account on identity mismatch and Add without confirming when unavailable", () => {
    const mismatch = profileCopyDraftActions(
      recordedOutcome({
        state: "account-confirmation-required",
        readiness: {
          preparation: "complete",
          verification: "verified",
          verificationRevision: 1,
          acceptedVerificationRevision: null,
          identity: "mismatch",
          identityRevision: 2,
          acceptedIdentityRevision: null,
          writer: "none",
          writerGeneration: 0,
          quarantined: false,
        },
      }),
      DRAFT_CONTEXT,
    );
    expect(mismatch.primary).toEqual({
      kind: "keep-account",
      label: "Keep this account",
    });
    expect(mismatch.secondary.map((action) => action.kind)).toContain(
      "sign-in",
    );

    const unavailable = profileCopyDraftActions(
      recordedOutcome({
        state: "account-confirmation-required",
        readiness: {
          preparation: "complete",
          verification: "verified",
          verificationRevision: 1,
          acceptedVerificationRevision: null,
          identity: "unavailable",
          identityRevision: 2,
          acceptedIdentityRevision: null,
          writer: "none",
          writerGeneration: 0,
          quarantined: false,
        },
      }),
      DRAFT_CONTEXT,
    );
    expect(unavailable.primary?.kind).toBe("add-without-confirming");
  });

  it("labels Verify again when a verify block exists even if readiness is not-checked", () => {
    const actions = profileCopyDraftActions(
      recordedOutcome({
        state: "verification-pending",
        readiness: {
          preparation: "complete",
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
      }),
      {
        ...DRAFT_CONTEXT,
        directBlock: {
          verb: "verify",
          revision: 1,
          reason: "login-start-unavailable",
          repeats: 1,
        },
      },
    );
    expect(actions.primary).toEqual({
      kind: "verify",
      label: "Verify again",
    });
  });

  it("offers Verify again, never Sign in, for a recorded blocked row with a verify block", () => {
    const unsupported = profileCopyDraftActions(
      recordedOutcome({
        state: "blocked",
        reason: "unsupported-auth",
      }),
      {
        ...DRAFT_CONTEXT,
        directBlock: {
          verb: "verify",
          revision: 1,
          reason: "unsupported-auth",
          repeats: 1,
        },
      },
    );
    expect(unsupported.primary?.kind).toBe("cancel-draft");
    expect(unsupported.secondary).toEqual([]);

    const retryable = profileCopyDraftActions(
      recordedOutcome({
        state: "blocked",
        reason: "login-start-unavailable",
      }),
      {
        ...DRAFT_CONTEXT,
        directBlock: {
          verb: "verify",
          revision: 1,
          reason: "login-start-unavailable",
          repeats: 1,
        },
      },
    );
    expect(retryable.primary).toEqual({
      kind: "verify",
      label: "Verify again",
    });
    expect(retryable.secondary.map((action) => action.kind)).toEqual([
      "cancel-draft",
    ]);
  });
});

describe("direct-block copy", () => {
  it("treats login-resource-busy and a repeated login-start-unavailable as shared", () => {
    const busy: ProfileCopyDirectBlock = {
      verb: "sign-in",
      revision: 1,
      reason: "login-resource-busy",
      repeats: 1,
    };
    const firstStart: ProfileCopyDirectBlock = {
      verb: "verify",
      revision: 1,
      reason: "login-start-unavailable",
      repeats: 1,
    };
    const secondStart: ProfileCopyDirectBlock = {
      ...firstStart,
      repeats: 2,
    };
    expect(isSharedResourceBlock(busy)).toBe(true);
    expect(isSharedResourceBlock(firstStart)).toBe(false);
    expect(isSharedResourceBlock(secondStart)).toBe(true);
  });

  it("words a verify block for the verb, not as a sign-in failure", () => {
    expect(
      profileCopyDirectBlockCopy(
        {
          verb: "verify",
          revision: 1,
          reason: "unsupported-auth",
          repeats: 1,
        },
        COPY_NAMES,
      ),
    ).toBe(
      `${COPY_NAMES.destination} refused the copied settings. Cancel this device and copy again — verifying again won't help.`,
    );
    expect(
      profileCopyDirectBlockCopy(
        {
          verb: "verify",
          revision: 1,
          reason: "login-start-unavailable",
          repeats: 1,
        },
        COPY_NAMES,
      ),
    ).toBe(
      `Verify couldn't start on ${COPY_NAMES.destination} right now. Try again.`,
    );
    expect(
      profileCopyDirectBlockCopy(
        {
          verb: "verify",
          revision: 1,
          reason: "login-start-unavailable",
          repeats: 2,
        },
        COPY_NAMES,
      ),
    ).toBe(profileCopySharedResourceCopy(COPY_NAMES));
    expect(
      profileCopyDirectBlockCopy(
        {
          verb: "sign-in",
          revision: 1,
          reason: "login-start-unavailable",
          repeats: 1,
        },
        COPY_NAMES,
      ),
    ).toBe(`Sign-in couldn't start on ${COPY_NAMES.destination} right now.`);
  });

  it("renders existing-account facts without an unknown-auth suffix", () => {
    expect(
      profileCopyExistingProfileFacts({
        enabled: false,
        authStatus: "authenticated",
      }),
    ).toBe("Turned off · Signed in");
    expect(
      profileCopyExistingProfileFacts({
        enabled: true,
        authStatus: "unknown",
      }),
    ).toBe("Enabled");
  });
});

describe("isRouteClosedReason", () => {
  it("treats admission and locality refusals as closed", () => {
    expect(isRouteClosedReason("adapter-not-admitted")).toBe(true);
    expect(isRouteClosedReason("manual-login-unavailable")).toBe(true);
    expect(isRouteClosedReason("destination-local-login-required")).toBe(true);
    expect(isRouteClosedReason("unreachable")).toBe(false);
    expect(isRouteClosedReason(null)).toBe(false);
  });
});

describe("started-job startRefusal", () => {
  it("withdraws Sign in for configuration and route-closed reasons only", () => {
    expect(startRefusalWithdrawsSignIn("login-start-unavailable")).toBe(true);
    expect(startRefusalWithdrawsSignIn("device-auth-unavailable")).toBe(true);
    expect(startRefusalWithdrawsSignIn("adapter-not-admitted")).toBe(true);
    expect(startRefusalWithdrawsSignIn("login-resource-busy")).toBe(false);
    expect(startRefusalWithdrawsSignIn("writer-unconfirmed")).toBe(false);
    expect(startRefusalWithdrawsSignIn(null)).toBe(false);
  });

  it("gives cancel-only when a start refusal withdraws Sign in", () => {
    const withdrawn = profileCopyDraftActions(
      recordedOutcome({ state: "sign-in-required" }),
      { ...DRAFT_CONTEXT, startRefusal: "device-auth-unavailable" },
    );
    expect(withdrawn.primary?.kind).toBe("cancel-draft");
    expect(withdrawn.secondary).toEqual([]);
    const busy = profileCopyDraftActions(
      recordedOutcome({ state: "sign-in-required" }),
      { ...DRAFT_CONTEXT, startRefusal: "login-resource-busy" },
    );
    expect(busy.primary?.kind).toBe("sign-in");
  });

  it("gives cancel-only for a recorded blocked row whose start refusal withdraws Sign in", () => {
    const actions = profileCopyDraftActions(
      recordedOutcome({
        state: "blocked",
        reason: "login-start-unavailable",
      }),
      { ...DRAFT_CONTEXT, startRefusal: "login-start-unavailable" },
    );
    expect(actions.primary?.kind).toBe("cancel-draft");
    expect(actions.secondary).toEqual([]);
  });

  it("words each started-job refusal", () => {
    expect(
      profileCopyStartRefusalCopy("login-start-unavailable", COPY_NAMES),
    ).toBe(
      "Sign-in couldn't start on Linux box: it may not accept the copied Claude Code settings. Cancel this device and copy again.",
    );
    expect(
      profileCopyStartRefusalCopy("device-auth-unavailable", COPY_NAMES),
    ).toBe(
      "Device-code sign-in isn't turned on for this Claude Code account. Turn it on in the account's security settings, then check again.",
    );
    expect(profileCopyStartRefusalCopy("login-resource-busy", COPY_NAMES)).toBe(
      profileCopySharedResourceCopy(COPY_NAMES),
    );
    expect(profileCopyStartRefusalCopy("writer-unconfirmed", COPY_NAMES)).toBe(
      "The copy to Linux box was interrupted before Traycer could confirm it finished safely.",
    );
  });
});
