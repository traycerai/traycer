import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { hostV115MutationV20Fixtures } from "./__fixtures__/host-v1.1.5-mutation-v20";
import {
  providerLoginProfileOutcomeSchema,
  providerLoginTargetRefusalSchema,
  providerMutationCliStateSchemaV21,
  providersAwaitLoginRequestSchema,
  providersAwaitLoginResponseSchema,
  providersStartLoginResponseSchemaV15,
  providersStartLoginRequestSchemaV14,
  providersStartLoginRequestSchemaV15,
} from "@traycer/protocol/host/provider-schemas";
import {
  decodeResponsePayload,
  prepareRequestPayload,
} from "@traycer/protocol/host-transport/remote/rpc-codec";

const startRegistry = hostRpcRegistry["providers.startLogin"];
const awaitRegistry = hostRpcRegistry["providers.awaitLogin"];
const startV15 = { major: 1, minor: 5 } as const;
const startV14 = { major: 1, minor: 4 } as const;
const awaitV24 = { major: 2, minor: 4 } as const;
const awaitV23 = { major: 2, minor: 3 } as const;
const awaitV20 = { major: 2, minor: 0 } as const;
const awaitV10 = { major: 1, minor: 0 } as const;

describe("provider login targets and outcomes", () => {
  it("accepts closed targets and refusals, defaulting absence to local", () => {
    const baseRequest = {
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: null,
    };
    expect(
      providersStartLoginRequestSchemaV15.parse(baseRequest).target,
    ).toBeNull();
    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...baseRequest,
        target: null,
      }).target,
    ).toBeNull();
    expect(
      providersStartLoginResponseSchemaV15.parse({
        url: null,
        started: false,
      }),
    ).not.toHaveProperty("targetRefusal");
    const malformedRefusal = providersStartLoginResponseSchemaV15.parse({
      url: null,
      started: false,
      targetRefusal: "unknown-refusal",
    });
    expect(malformedRefusal.targetRefusal).toBeNull();
    expect(malformedRefusal.started).toBe(false);
    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...baseRequest,
        target: { kind: "environment", environmentId: "env-1" },
      }).target,
    ).toEqual({ kind: "environment", environmentId: "env-1", profileId: null });
    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...baseRequest,
        target: { kind: "leave-to-local", profileId: "folder-alias" },
      }).target,
    ).toEqual({ kind: "leave-to-local", profileId: "folder-alias" });

    expect(
      providersStartLoginRequestSchemaV15.safeParse({
        ...baseRequest,
        target: { kind: "leave-to-local", profileId: "" },
      }).success,
    ).toBe(false);
    expect(
      providersStartLoginRequestSchemaV15.safeParse({
        ...baseRequest,
        target: { kind: "unknown-target" },
      }).success,
    ).toBe(false);

    const refusals = [
      "unsupported-computer",
      "not-authorized",
      "target-unavailable",
      "target-removed",
      "invalid-leave-profile",
      "not-available-yet",
    ] as const;
    for (const refusal of refusals) {
      expect(providerLoginTargetRefusalSchema.parse(refusal)).toBe(refusal);
    }
    expect(
      providerLoginTargetRefusalSchema.safeParse("other-refusal").success,
    ).toBe(false);
  });

  it("accepts all seven profile outcomes with their closed refusal reasons", () => {
    const outcomes = [
      { kind: "waiting-for-profile" },
      { kind: "account-mismatch" },
      { kind: "account-unproven" },
      { kind: "target-refused", reason: "not-authorized" },
      { kind: "target-refused", reason: "target-unavailable" },
      { kind: "target-refused", reason: "target-removed" },
      { kind: "target-refused", reason: "offer-refused" },
      { kind: "staged-for-leave", profileId: "folder-alias" },
      { kind: "signed-in", profileId: "local-row" },
      { kind: "already-signed-in", profileId: "destination-row" },
    ] as const;
    for (const outcome of outcomes) {
      expect(providerLoginProfileOutcomeSchema.parse(outcome)).toEqual(outcome);
    }
    expect(
      providerLoginProfileOutcomeSchema.safeParse({
        kind: "target-refused",
        reason: "provider-error-text",
      }).success,
    ).toBe(false);
    expect(
      providerLoginProfileOutcomeSchema.safeParse({
        kind: "signed-in",
        profileId: "",
      }).success,
    ).toBe(false);
  });

  it("keeps released login lines frozen and upgrades every older request line", () => {
    const startLine = startRegistry[1];
    expect(startLine.latestMinor).toBe(5);
    const historicalStart = startLine.versions[4].contract;
    const oldStart = historicalStart.requestSchema.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: "opaque-holder",
      target: { kind: "leave-to-local", profileId: "must-be-stripped" },
    });
    expect(Object.keys(oldStart).sort()).toEqual(
      ["providerId", "profileId", "createProfile", "holderId"].sort(),
    );
    expect(
      historicalStart.responseSchema.parse({
        url: null,
        started: false,
        profileId: null,
        userCode: null,
        failure: null,
        pending: null,
        pack: null,
        targetRefusal: "target-removed",
      }),
    ).not.toHaveProperty("targetRefusal");

    const upgradedStart = upgradeRequestToVersion(
      startRegistry,
      { major: 1, minor: 0 },
      startV15,
      { providerId: "codex" },
    );
    expect(upgradedStart).toMatchObject({
      profileId: null,
      createProfile: null,
      holderId: null,
      target: null,
    });
    expect(
      upgradeRequestToVersion(awaitRegistry, awaitV20, awaitV24, {
        providerId: "codex",
      }),
    ).toEqual({
      providerId: "codex",
      profileId: null,
      lastSeenReaderCount: null,
    });
    expect(
      upgradeResponseToVersion(
        startRegistry,
        { major: 1, minor: 4 },
        startV15,
        startLine.versions[4].contract.responseSchema.parse({
          url: null,
          started: false,
        }),
      ),
    ).toMatchObject({ targetRefusal: null });

    const awaitLine = awaitRegistry[2];
    expect(awaitLine.latestMinor).toBe(4);
    const liveV24 = providersAwaitLoginResponseSchema.parse({
      state: null,
      profileOutcome: { kind: "signed-in", profileId: "row-1" },
    });
    expect(liveV24.profileOutcome).toEqual({
      kind: "signed-in",
      profileId: "row-1",
    });
    expect(
      providersAwaitLoginResponseSchema.parse({ state: null }).profileOutcome,
    ).toBeUndefined();
    const malformedOutcome = providersAwaitLoginResponseSchema.parse({
      state: null,
      profileOutcome: { kind: "unknown-outcome" },
    });
    expect(malformedOutcome.profileOutcome).toBeNull();
    expect(malformedOutcome.state).toBeNull();
  });

  it("uses the remote codec: target loss below 1.5 and defaults from old await peers", () => {
    const targetedRequest = providersStartLoginRequestSchemaV15.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: "opaque-holder",
      target: { kind: "environment", environmentId: "env-1", profileId: null },
    });
    const projectedStart = prepareRequestPayload(
      startRegistry,
      startV15,
      startV14,
      targetedRequest,
      "request-1",
      "providers.startLogin",
    );
    expect(projectedStart.onWirePayload).not.toHaveProperty("target");
    expect(
      providersStartLoginRequestSchemaV14.parse(projectedStart.onWirePayload),
    ).toMatchObject({ holderId: "opaque-holder" });

    const legacyStart = providersStartLoginRequestSchemaV14.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: "opaque-holder",
    });
    expect(legacyStart).not.toHaveProperty("target");

    const oldAwaitRequest = prepareRequestPayload(
      awaitRegistry,
      awaitV24,
      awaitV20,
      {
        providerId: "codex",
        profileId: "opaque-await-handle",
        lastSeenReaderCount: 2,
      },
      "request-2",
      "providers.awaitLogin",
    );
    expect(oldAwaitRequest.onWirePayload).toEqual({ providerId: "codex" });
    expect(
      providersAwaitLoginRequestSchema.parse({
        providerId: "codex",
        profileId: "opaque-await-handle",
      }).profileId,
    ).toBe("opaque-await-handle");
    const oldAwaitResponse = decodeResponsePayload(
      awaitRegistry,
      awaitV24,
      awaitV23,
      {
        state: null,
        existingProfileId: null,
        codeRejected: false,
        refusal: null,
        installation: null,
      },
      "request-3",
      "providers.awaitLogin",
    );
    expect(oldAwaitResponse).toMatchObject({
      profileOutcome: null,
      installation: null,
    });
  });

  it("downgrades 2.4 through its V23 bridge to strict V1.0 without new fields", () => {
    const request = downgradeRequestAcrossMajors(awaitRegistry, 2, 1, {
      providerId: "codex",
      profileId: "opaque-await-handle",
      lastSeenReaderCount: 4,
    });
    expect(request).toEqual({ ok: true, value: { providerId: "codex" } });

    const response = downgradeResponseAcrossMajors(awaitRegistry, 2, 1, {
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
      installation: null,
      profileOutcome: { kind: "staged-for-leave", profileId: "folder-alias" },
    });
    expect(response).toEqual({ ok: true, value: { state: null } });

    const providerIneligibleResponse = downgradeResponseAcrossMajors(
      awaitRegistry,
      2,
      1,
      {
        state: providerMutationCliStateSchemaV21.parse(
          hostV115MutationV20Fixtures.minimalStatesByProviderId.amp,
        ),
        existingProfileId: null,
        codeRejected: false,
        refusal: null,
        installation: null,
        profileOutcome: null,
      },
    );
    expect(providerIneligibleResponse).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });

    const upgraded = upgradeResponseToVersion(
      awaitRegistry,
      awaitV10,
      awaitV24,
      { state: null },
    );
    expect(upgraded).toMatchObject({
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
      installation: null,
      profileOutcome: null,
    });
  });
});
