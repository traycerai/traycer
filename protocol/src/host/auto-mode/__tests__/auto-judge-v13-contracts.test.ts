import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  autoJudgeGetResponseSchema,
  autoJudgeGetResponseSchemaV10,
  autoJudgeGetResponseSchemaV11,
  autoJudgeGetResponseSchemaV12,
  autoJudgeGetUpgradeV12ToV13,
  autoJudgeGetV10,
  autoJudgeGetV11,
  autoJudgeGetV12,
  autoJudgeGetV13,
  autoJudgeSelectionSchema,
  autoJudgeSelectionSchemaPreEffort,
  autoJudgeSetRequestSchema,
  autoJudgeSetRequestSchemaPreEffort,
  autoJudgeSetResponseSchema,
  autoJudgeSetResponseSchemaV10,
  autoJudgeSetResponseSchemaV11,
  autoJudgeSetResponseSchemaV12,
  autoJudgeSetUpgradeV12ToV13,
  autoJudgeSetV10,
  autoJudgeSetV11,
  autoJudgeSetV12,
  autoJudgeSetV13,
  projectAutoJudgeGetResponseToV10,
  projectAutoJudgeSetResponseToV10,
  type AutoJudgeGetResponse,
  type AutoJudgeGetResponseV10,
  type AutoJudgeSetResponse,
  type AutoJudgeSetResponseV10,
} from "@traycer/protocol/host/auto-mode/contracts";

/**
 * `autoJudge.get` / `autoJudge.set`'s `1.3` line: the `reasoningEffort` key
 * added to the judge selection, on the `set` request and on both responses'
 * `selection` and `lastSelection`. It is a KEY, not a value or union-arm
 * change, so no `responseGrowthProjectionGated` is declared for it - a
 * `<=1.2` caller's non-strict decode drops the key on its own, and the `1.0`
 * projection strips it by construction. See `contracts.ts`'s module docblock
 * and the `1.3` section comment for the motivation.
 */

const preEffort = {
  harnessId: "claude",
  model: "claude-sonnet",
  profileId: null,
};

const selectionEffective = {
  harnessId: "claude",
  model: "claude-sonnet",
  source: "selection" as const,
};

describe("autoJudge selection: 1.3 requires reasoningEffort, <=1.2 does not", () => {
  it("the live selection schema requires reasoningEffort", () => {
    expect(autoJudgeSelectionSchema.safeParse(preEffort).success).toBe(false);
    expect(
      autoJudgeSelectionSchema.safeParse({
        ...preEffort,
        reasoningEffort: null,
      }).success,
    ).toBe(true);
    expect(
      autoJudgeSelectionSchema.safeParse({
        ...preEffort,
        reasoningEffort: "low",
      }).success,
    ).toBe(true);
  });

  it("the same literal (no reasoningEffort) parses under the frozen pre-effort schema", () => {
    expect(autoJudgeSelectionSchemaPreEffort.safeParse(preEffort).success).toBe(
      true,
    );
  });

  it("the 1.3 set request requires the effort key; the <=1.2 request does not carry it", () => {
    expect(
      autoJudgeSetRequestSchema.safeParse({ selection: preEffort }).success,
    ).toBe(false);
    expect(
      autoJudgeSetRequestSchema.safeParse({
        selection: { ...preEffort, reasoningEffort: "high" },
      }).success,
    ).toBe(true);
    expect(
      autoJudgeSetRequestSchemaPreEffort.safeParse({ selection: preEffort })
        .success,
    ).toBe(true);
  });
});

describe("autoJudge.get/set@1.2 -> 1.3: the upgrade", () => {
  it("upgradeRequest passes a get request through unchanged", () => {
    const request = {};
    expect(autoJudgeGetUpgradeV12ToV13.upgradeRequest(request)).toEqual(
      request,
    );
  });

  it("set's upgradeRequest turns a 1.2 selection into one with reasoningEffort: null", () => {
    const upgraded = autoJudgeSetUpgradeV12ToV13.upgradeRequest({
      selection: preEffort,
    });
    expect(upgraded).toEqual({
      selection: { ...preEffort, reasoningEffort: null },
    });
    expect(autoJudgeSetV13.requestSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("set's upgradeRequest passes selection: null through unchanged", () => {
    const upgraded = autoJudgeSetUpgradeV12ToV13.upgradeRequest(
      autoJudgeSetRequestSchemaPreEffort.parse({ selection: null }),
    );
    expect(upgraded).toEqual({ selection: null });
  });

  it("get's upgradeResponse adds reasoningEffort: null to selection AND lastSelection, and leaves effective/blocked untouched", () => {
    const v12Response = autoJudgeGetResponseSchemaV12.parse({
      selection: preEffort,
      effective: selectionEffective,
      blocked: null,
      lastSelection: preEffort,
    });
    const upgraded = autoJudgeGetUpgradeV12ToV13.upgradeResponse(v12Response);
    expect(upgraded).toEqual({
      selection: { ...preEffort, reasoningEffort: null },
      effective: selectionEffective,
      blocked: null,
      lastSelection: { ...preEffort, reasoningEffort: null },
    });
    expect(autoJudgeGetV13.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("get's upgradeResponse keeps an absent lastSelection absent, and a null one null", () => {
    const absent = autoJudgeGetUpgradeV12ToV13.upgradeResponse(
      autoJudgeGetResponseSchemaV12.parse({ selection: null }),
    );
    expect(absent.selection).toBeNull();
    expect(Object.hasOwn(absent, "lastSelection")).toBe(false);
    expect(Object.hasOwn(absent, "effective")).toBe(false);
    expect(Object.hasOwn(absent, "blocked")).toBe(false);

    const asNull = autoJudgeGetUpgradeV12ToV13.upgradeResponse(
      autoJudgeGetResponseSchemaV12.parse({
        selection: null,
        lastSelection: null,
      }),
    );
    expect(asNull.lastSelection).toBeNull();
  });

  it("get's upgradeResponse leaves a fallback effective untouched", () => {
    const upgraded = autoJudgeGetUpgradeV12ToV13.upgradeResponse(
      autoJudgeGetResponseSchemaV12.parse({
        selection: null,
        effective: { source: "fallback" },
        blocked: null,
      }),
    );
    expect(upgraded.effective).toEqual({ source: "fallback" });
    expect(upgraded.selection).toBeNull();
  });

  it("set's upgradeResponse adds reasoningEffort: null the same way", () => {
    const v12Response = autoJudgeSetResponseSchemaV12.parse({
      selection: preEffort,
      effective: null,
      blocked: { reason: "unsupported-harness" },
      lastSelection: preEffort,
    });
    const upgraded = autoJudgeSetUpgradeV12ToV13.upgradeResponse(v12Response);
    expect(upgraded).toEqual({
      selection: { ...preEffort, reasoningEffort: null },
      effective: null,
      blocked: { reason: "unsupported-harness" },
      lastSelection: { ...preEffort, reasoningEffort: null },
    });
    expect(autoJudgeSetV13.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });
});

describe("autoJudge.get/set@<=1.2 parse of a 1.3 answer strips the effort", () => {
  it("a 1.2 caller's re-parse drops reasoningEffort from selection and lastSelection", () => {
    const head: AutoJudgeGetResponse = {
      selection: { ...preEffort, reasoningEffort: "low" },
      effective: selectionEffective,
      blocked: null,
      lastSelection: { ...preEffort, reasoningEffort: "low" },
    };
    const parsed = autoJudgeGetV12.responseSchema.parse(head);
    expect(parsed).toEqual({
      selection: preEffort,
      effective: selectionEffective,
      blocked: null,
      lastSelection: preEffort,
    });
    const setParsed = autoJudgeSetV12.responseSchema.parse(head);
    expect(setParsed).toEqual({
      selection: preEffort,
      effective: selectionEffective,
      blocked: null,
      lastSelection: preEffort,
    });
  });

  it("a 1.1 caller's re-parse drops the effort and lastSelection both", () => {
    const head: AutoJudgeGetResponse = {
      selection: { ...preEffort, reasoningEffort: "low" },
      effective: selectionEffective,
      blocked: null,
      lastSelection: { ...preEffort, reasoningEffort: "low" },
    };
    expect(autoJudgeGetV11.responseSchema.parse(head)).toEqual({
      selection: preEffort,
      effective: selectionEffective,
      blocked: null,
    });
  });
});

describe("autoJudge.get/set@1.3 -> 1.0: the projection strips the effort", () => {
  it("strips reasoningEffort from selection and maps a fallback effective to provider-disabled", () => {
    const input: AutoJudgeGetResponse = {
      selection: { ...preEffort, reasoningEffort: "high" },
      effective: { source: "fallback" },
      blocked: null,
      lastSelection: { ...preEffort, reasoningEffort: "high" },
    };
    const expected: AutoJudgeGetResponseV10 = {
      selection: preEffort,
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeGetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(
      projected.selection !== null &&
        Object.hasOwn(projected.selection, "reasoningEffort"),
    ).toBe(false);
    expect(Object.hasOwn(projected, "lastSelection")).toBe(false);
    expect(autoJudgeGetV10.responseSchema.safeParse(projected).success).toBe(
      true,
    );
  });

  it("does the same projection for autoJudge.set's echo", () => {
    const input: AutoJudgeSetResponse = {
      selection: { ...preEffort, reasoningEffort: "low" },
      effective: { source: "fallback" },
      blocked: null,
    };
    const expected: AutoJudgeSetResponseV10 = {
      selection: preEffort,
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeSetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(autoJudgeSetV10.responseSchema.safeParse(projected).success).toBe(
      true,
    );
  });

  it("strips reasoningEffort even when effective is not a fallback", () => {
    const input: AutoJudgeGetResponse = {
      selection: { ...preEffort, reasoningEffort: null },
      effective: selectionEffective,
      blocked: null,
    };
    const projected = projectAutoJudgeGetResponseToV10(input);
    expect(projected.selection).toEqual(preEffort);
    expect(projected.effective).toEqual(input.effective);
  });

  it("passes a null selection through as null", () => {
    const input: AutoJudgeGetResponse = { selection: null };
    expect(projectAutoJudgeGetResponseToV10(input).selection).toBeNull();
  });
});

describe("autoJudge.get/set: the frozen request/response identities", () => {
  it("binds the 1.0 objects by identity, on the pre-effort request", () => {
    expect(autoJudgeGetV10.responseSchema).toBe(autoJudgeGetResponseSchemaV10);
    expect(autoJudgeSetV10.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV10.responseSchema).toBe(autoJudgeSetResponseSchemaV10);
  });

  it("binds the 1.1 objects by identity, on the pre-effort request", () => {
    expect(autoJudgeGetV11.responseSchema).toBe(autoJudgeGetResponseSchemaV11);
    expect(autoJudgeSetV11.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV11.responseSchema).toBe(autoJudgeSetResponseSchemaV11);
  });

  it("binds the 1.2 objects by identity, on the pre-effort request", () => {
    expect(autoJudgeGetV12.responseSchema).toBe(autoJudgeGetResponseSchemaV12);
    expect(autoJudgeSetV12.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV12.responseSchema).toBe(autoJudgeSetResponseSchemaV12);
  });

  it("binds the canonical head names to the 1.3 objects", () => {
    expect(autoJudgeGetV13.responseSchema).toBe(autoJudgeGetResponseSchema);
    expect(autoJudgeSetV13.requestSchema).toBe(autoJudgeSetRequestSchema);
    expect(autoJudgeSetV13.responseSchema).toBe(autoJudgeSetResponseSchema);
  });
});

describe("autoJudge.get/set registry entries at 1.3", () => {
  it("has latestMinor 3 for both methods, with version 3 bound to the V13 contracts and their upgrade paths", () => {
    for (const method of ["autoJudge.get", "autoJudge.set"] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(3);
    }

    const getEntry = hostRpcRegistry["autoJudge.get"][1].versions[3];
    expect(getEntry.contract).toBe(autoJudgeGetV13);
    expect(getEntry.upgradeFromPreviousVersion).toBe(
      autoJudgeGetUpgradeV12ToV13,
    );
    // A new KEY is structural growth: a <=1.2 caller's non-strict decode
    // drops it, so no value/union-arm growth claim is made for 1.3.
    expect(Object.hasOwn(getEntry, "responseGrowthProjectionGated")).toBe(
      false,
    );

    const setEntry = hostRpcRegistry["autoJudge.set"][1].versions[3];
    expect(setEntry.contract).toBe(autoJudgeSetV13);
    expect(setEntry.upgradeFromPreviousVersion).toBe(
      autoJudgeSetUpgradeV12ToV13,
    );
    expect(Object.hasOwn(setEntry, "responseGrowthProjectionGated")).toBe(
      false,
    );
  });

  it("validates the registry as constructed", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
  });
});
