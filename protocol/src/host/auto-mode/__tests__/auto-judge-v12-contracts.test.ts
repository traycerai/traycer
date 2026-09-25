import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  autoJudgeGetResponseSchema,
  autoJudgeGetResponseSchemaV10,
  autoJudgeGetResponseSchemaV11,
  autoJudgeGetUpgradeV11ToV12,
  autoJudgeGetV10,
  autoJudgeGetV11,
  autoJudgeGetV12,
  autoJudgeSelectionSchema,
  autoJudgeSelectionSchemaPreEffort,
  autoJudgeSetRequestSchemaPreEffort,
  autoJudgeSetResponseSchema,
  autoJudgeSetResponseSchemaV10,
  autoJudgeSetResponseSchemaV11,
  autoJudgeSetUpgradeV11ToV12,
  autoJudgeSetV10,
  autoJudgeSetV11,
  autoJudgeSetV12,
  projectAutoJudgeGetResponseToV10,
  projectAutoJudgeSetResponseToV10,
  type AutoJudgeGetResponse,
  type AutoJudgeGetResponseV10,
  type AutoJudgeSetResponse,
  type AutoJudgeSetResponseV10,
} from "@traycer/protocol/host/auto-mode/contracts";

/**
 * `autoJudge.get` / `autoJudge.set`'s `1.2` line: the `reasoningEffort` key
 * added to the judge selection. Unlike `1.1`, this is REQUEST growth too (the
 * `set` request's `selection` gains the field), and it is a KEY, not a value
 * or union-arm change, so no `responseGrowthProjectionGated` is declared for
 * it - a `<=1.1` caller's non-strict decode drops the key on its own. See
 * `contracts.ts`'s module docblock and the `1.2` section comment for the
 * motivation.
 */

describe("autoJudge selection: 1.2 requires reasoningEffort, 1.0/1.1 do not", () => {
  it("the live selection schema requires reasoningEffort", () => {
    const withoutEffort = {
      harnessId: "claude",
      model: "claude-sonnet",
      profileId: null,
    };
    expect(autoJudgeSelectionSchema.safeParse(withoutEffort).success).toBe(
      false,
    );
    expect(
      autoJudgeSelectionSchema.safeParse({
        ...withoutEffort,
        reasoningEffort: null,
      }).success,
    ).toBe(true);
    expect(
      autoJudgeSelectionSchema.safeParse({
        ...withoutEffort,
        reasoningEffort: "low",
      }).success,
    ).toBe(true);
  });

  it("the same literal (no reasoningEffort) parses under the frozen pre-effort schema", () => {
    const withoutEffort = {
      harnessId: "claude",
      model: "claude-sonnet",
      profileId: null,
    };
    expect(
      autoJudgeSelectionSchemaPreEffort.safeParse(withoutEffort).success,
    ).toBe(true);
  });
});

describe("autoJudge.get/set@1.1 -> 1.2: the upgrade", () => {
  it("upgradeRequest passes a get request through unchanged", () => {
    const request = {};
    expect(autoJudgeGetUpgradeV11ToV12.upgradeRequest(request)).toEqual(
      request,
    );
  });

  it("set's upgradeRequest turns a 1.1 selection into one with reasoningEffort: null", () => {
    const v11Request = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
    };
    const upgraded = autoJudgeSetUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded).toEqual({
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
    });
    // The upgraded shape is a valid 1.2 request.
    const parsed = autoJudgeSetV12.requestSchema.safeParse(upgraded);
    expect(parsed.success).toBe(true);
  });

  it("set's upgradeRequest passes selection: null through unchanged", () => {
    const v11Request = autoJudgeSetRequestSchemaPreEffort.parse({
      selection: null,
    });
    const upgraded = autoJudgeSetUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded).toEqual({ selection: null });
  });

  it("get's upgradeResponse adds reasoningEffort: null to a selection and leaves effective/blocked untouched", () => {
    const v11Response = autoJudgeGetResponseSchemaV11.parse({
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      effective: {
        harnessId: "claude",
        model: "claude-sonnet",
        source: "selection",
      },
      blocked: null,
    });
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11Response);
    expect(upgraded).toEqual({
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
      effective: {
        harnessId: "claude",
        model: "claude-sonnet",
        source: "selection",
      },
      blocked: null,
    });
    expect(autoJudgeGetV12.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("get's upgradeResponse leaves a fallback effective untouched", () => {
    const v11Response = autoJudgeGetResponseSchemaV11.parse({
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    });
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11Response);
    expect(upgraded.effective).toEqual({ source: "fallback" });
    expect(upgraded.selection).toBeNull();
  });

  it("get's upgradeResponse turns a null selection into null, not an object", () => {
    const v11Response = autoJudgeGetResponseSchemaV11.parse({
      selection: null,
    });
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11Response);
    expect(upgraded.selection).toBeNull();
  });

  it("set's upgradeResponse adds reasoningEffort: null to a selection and leaves effective/blocked untouched", () => {
    const v11Response = autoJudgeSetResponseSchemaV11.parse({
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
    const upgraded = autoJudgeSetUpgradeV11ToV12.upgradeResponse(v11Response);
    expect(upgraded).toEqual({
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
    expect(autoJudgeSetV12.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("set's upgradeResponse leaves a fallback effective untouched", () => {
    const v11Response = autoJudgeSetResponseSchemaV11.parse({
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    });
    const upgraded = autoJudgeSetUpgradeV11ToV12.upgradeResponse(v11Response);
    expect(upgraded.effective).toEqual({ source: "fallback" });
  });
});

describe("autoJudge.get/set@1.2 -> 1.0: the projection still strips the effort", () => {
  it("strips reasoningEffort from selection and maps a fallback effective to provider-disabled", () => {
    const input: AutoJudgeGetResponse = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: "high",
      },
      effective: { source: "fallback" },
      blocked: null,
    };
    const expected: AutoJudgeGetResponseV10 = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeGetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(
      projected.selection !== null &&
        Object.hasOwn(projected.selection, "reasoningEffort"),
    ).toBe(false);
    expect(autoJudgeGetV10.responseSchema.safeParse(projected).success).toBe(
      true,
    );
  });

  it("does the same projection for autoJudge.set's echo", () => {
    const input: AutoJudgeSetResponse = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: "low",
      },
      effective: { source: "fallback" },
      blocked: null,
    };
    const expected: AutoJudgeSetResponseV10 = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeSetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(
      projected.selection !== null &&
        Object.hasOwn(projected.selection, "reasoningEffort"),
    ).toBe(false);
    expect(autoJudgeSetV10.responseSchema.safeParse(projected).success).toBe(
      true,
    );
  });

  it("strips reasoningEffort even when effective is not a fallback", () => {
    const input: AutoJudgeGetResponse = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
      effective: {
        harnessId: "claude",
        model: "claude-sonnet",
        source: "selection",
      },
      blocked: null,
    };
    const projected = projectAutoJudgeGetResponseToV10(input);
    expect(projected.selection).toEqual({
      harnessId: "claude",
      model: "claude-sonnet",
      profileId: null,
    });
    expect(projected.effective).toEqual(input.effective);
  });

  it("passes a null selection through as null", () => {
    const input: AutoJudgeGetResponse = { selection: null };
    expect(projectAutoJudgeGetResponseToV10(input).selection).toBeNull();
  });
});

describe("autoJudge.get/set@1.0/1.1 -> 1.2: the frozen request/response identities", () => {
  it("binds the 1.0 request/response objects by identity", () => {
    expect(autoJudgeGetV10.responseSchema).toBe(autoJudgeGetResponseSchemaV10);
    expect(autoJudgeSetV10.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV10.responseSchema).toBe(autoJudgeSetResponseSchemaV10);
  });

  it("binds the 1.1 request/response objects by identity", () => {
    expect(autoJudgeGetV11.responseSchema).toBe(autoJudgeGetResponseSchemaV11);
    // 1.1 changes the response only; the request is still the pre-effort one.
    expect(autoJudgeSetV11.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV11.responseSchema).toBe(autoJudgeSetResponseSchemaV11);
  });

  it("binds the canonical head names to the 1.2 objects", () => {
    expect(autoJudgeGetV12.responseSchema).toBe(autoJudgeGetResponseSchema);
    expect(autoJudgeSetV12.responseSchema).toBe(autoJudgeSetResponseSchema);
  });
});

describe("autoJudge.get/set registry entries at 1.2", () => {
  it("has latestMinor 2 for both methods, with version 2 bound to the V12 contracts and their upgrade paths", () => {
    for (const method of ["autoJudge.get", "autoJudge.set"] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(2);
    }

    const getEntry = hostRpcRegistry["autoJudge.get"][1].versions[2];
    expect(getEntry.contract).toBe(autoJudgeGetV12);
    expect(getEntry.upgradeFromPreviousVersion).toBe(
      autoJudgeGetUpgradeV11ToV12,
    );
    // A new KEY is structural growth: a <=1.1 caller's non-strict decode
    // drops it, so no value/union-arm growth claim is made for 1.2.
    expect("responseGrowthProjectionGated" in getEntry).toBe(false);

    const setEntry = hostRpcRegistry["autoJudge.set"][1].versions[2];
    expect(setEntry.contract).toBe(autoJudgeSetV12);
    expect(setEntry.upgradeFromPreviousVersion).toBe(
      autoJudgeSetUpgradeV11ToV12,
    );
    expect("responseGrowthProjectionGated" in setEntry).toBe(false);
  });

  it("validates the registry as constructed", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
  });
});
