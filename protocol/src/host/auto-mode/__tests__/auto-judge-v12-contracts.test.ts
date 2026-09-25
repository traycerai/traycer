import { describe, expect, it } from "vitest";
import {
  autoJudgeGetUpgradeV10ToV11,
  autoJudgeGetUpgradeV11ToV12,
  autoJudgeGetV10,
  autoJudgeGetV11,
  autoJudgeGetV12,
  autoJudgeSetUpgradeV10ToV11,
  autoJudgeSetUpgradeV11ToV12,
  autoJudgeSetV10,
  autoJudgeSetV11,
  autoJudgeSetV12,
  projectAutoJudgeGetResponseToV10,
  projectAutoJudgeSetResponseToV10,
  type AutoJudgeGetRequest,
  type AutoJudgeGetResponse,
  type AutoJudgeGetResponseV10,
  type AutoJudgeGetResponseV11,
  type AutoJudgeSelection,
  type AutoJudgeSetRequest,
  type AutoJudgeSetResponse,
  type AutoJudgeSetResponseV10,
  type AutoJudgeSetResponseV11,
} from "@traycer/protocol/host/auto-mode/contracts";

/**
 * `autoJudge.get` / `autoJudge.set`'s `1.2` line: the optional `lastSelection`
 * key, the `1.1` -> `1.2` upgrade that cannot invent it, and the `1.0`
 * projection that never copies it. See `contracts.ts`'s module docblock.
 */

const selection: AutoJudgeSelection = {
  harnessId: "claude",
  model: "claude-sonnet",
  profileId: null,
};

const selectionEffective = {
  harnessId: "claude",
  model: "claude-sonnet",
  source: "selection" as const,
};

describe("autoJudge.get/set@1.1 -> 1.2: the upgrade", () => {
  it("leaves lastSelection absent and preserves a non-null selection with effective/blocked", () => {
    const v11: AutoJudgeGetResponseV11 = {
      selection,
      effective: selectionEffective,
      blocked: null,
    };
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11);
    expect(Object.hasOwn(upgraded, "lastSelection")).toBe(false);
    expect(upgraded.selection).toEqual(selection);
    expect(upgraded.effective).toEqual(selectionEffective);
    expect(upgraded.blocked).toBeNull();
    expect(autoJudgeGetV12.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );

    const setV11: AutoJudgeSetResponseV11 = {
      selection,
      effective: selectionEffective,
      blocked: null,
    };
    const setUpgraded = autoJudgeSetUpgradeV11ToV12.upgradeResponse(setV11);
    expect(Object.hasOwn(setUpgraded, "lastSelection")).toBe(false);
    expect(setUpgraded.selection).toEqual(selection);
    expect(setUpgraded.effective).toEqual(selectionEffective);
    expect(setUpgraded.blocked).toBeNull();
    expect(autoJudgeSetV12.responseSchema.safeParse(setUpgraded).success).toBe(
      true,
    );
  });

  it("leaves lastSelection absent with a null selection and a fallback effective", () => {
    const v11: AutoJudgeGetResponseV11 = {
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    };
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11);
    expect(Object.hasOwn(upgraded, "lastSelection")).toBe(false);
    expect(upgraded.selection).toBeNull();
    expect(upgraded.effective).toEqual({ source: "fallback" });
    expect(upgraded.blocked).toBeNull();
    expect(autoJudgeGetV12.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );

    const setV11: AutoJudgeSetResponseV11 = {
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    };
    const setUpgraded = autoJudgeSetUpgradeV11ToV12.upgradeResponse(setV11);
    expect(Object.hasOwn(setUpgraded, "lastSelection")).toBe(false);
    expect(setUpgraded.selection).toBeNull();
    expect(setUpgraded.effective).toEqual({ source: "fallback" });
    expect(setUpgraded.blocked).toBeNull();
    expect(autoJudgeSetV12.responseSchema.safeParse(setUpgraded).success).toBe(
      true,
    );
  });

  it("preserves absent effective/blocked as absent", () => {
    const v11: AutoJudgeGetResponseV11 = { selection: null };
    const upgraded = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11);
    expect(Object.hasOwn(upgraded, "lastSelection")).toBe(false);
    expect(Object.hasOwn(upgraded, "effective")).toBe(false);
    expect(Object.hasOwn(upgraded, "blocked")).toBe(false);
    expect(upgraded.selection).toBeNull();
    expect(autoJudgeGetV12.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );

    const setV11: AutoJudgeSetResponseV11 = { selection: null };
    const setUpgraded = autoJudgeSetUpgradeV11ToV12.upgradeResponse(setV11);
    expect(Object.hasOwn(setUpgraded, "lastSelection")).toBe(false);
    expect(Object.hasOwn(setUpgraded, "effective")).toBe(false);
    expect(Object.hasOwn(setUpgraded, "blocked")).toBe(false);
    expect(autoJudgeSetV12.responseSchema.safeParse(setUpgraded).success).toBe(
      true,
    );
  });

  it("upgradeRequest is identity", () => {
    const getRequest: AutoJudgeGetRequest = {};
    expect(autoJudgeGetUpgradeV11ToV12.upgradeRequest(getRequest)).toBe(
      getRequest,
    );

    const setRequest: AutoJudgeSetRequest = { selection };
    expect(autoJudgeSetUpgradeV11ToV12.upgradeRequest(setRequest)).toBe(
      setRequest,
    );
    const setNull: AutoJudgeSetRequest = { selection: null };
    expect(autoJudgeSetUpgradeV11ToV12.upgradeRequest(setNull)).toBe(setNull);
  });
});

describe("autoJudge.get/set@1.1 parse of a 1.2 answer", () => {
  it("drops lastSelection as an object and otherwise equals the input minus the key", () => {
    const v12: AutoJudgeGetResponse = {
      selection,
      effective: selectionEffective,
      blocked: null,
      lastSelection: selection,
    };
    const parsed = autoJudgeGetV11.responseSchema.parse(v12);
    expect(Object.hasOwn(parsed, "lastSelection")).toBe(false);
    expect(parsed).toEqual({
      selection,
      effective: selectionEffective,
      blocked: null,
    });

    const setV12: AutoJudgeSetResponse = {
      selection,
      effective: selectionEffective,
      blocked: null,
      lastSelection: selection,
    };
    const setParsed = autoJudgeSetV11.responseSchema.parse(setV12);
    expect(Object.hasOwn(setParsed, "lastSelection")).toBe(false);
    expect(setParsed).toEqual({
      selection,
      effective: selectionEffective,
      blocked: null,
    });
  });

  it("drops lastSelection: null the same way", () => {
    const v12: AutoJudgeGetResponse = {
      selection,
      effective: selectionEffective,
      blocked: null,
      lastSelection: null,
    };
    const parsed = autoJudgeGetV11.responseSchema.parse(v12);
    expect(Object.hasOwn(parsed, "lastSelection")).toBe(false);
    expect(parsed).toEqual({
      selection,
      effective: selectionEffective,
      blocked: null,
    });

    const setV12: AutoJudgeSetResponse = {
      selection,
      effective: selectionEffective,
      blocked: null,
      lastSelection: null,
    };
    const setParsed = autoJudgeSetV11.responseSchema.parse(setV12);
    expect(Object.hasOwn(setParsed, "lastSelection")).toBe(false);
    expect(setParsed).toEqual({
      selection,
      effective: selectionEffective,
      blocked: null,
    });
  });
});

describe("autoJudge.get/set@1.2 head schema", () => {
  it("accepts lastSelection as an object, as null, and absent (absent stays absent)", () => {
    const asObject = autoJudgeGetV12.responseSchema.parse({
      selection: null,
      lastSelection: selection,
    });
    expect(asObject.lastSelection).toEqual(selection);

    const asNull = autoJudgeGetV12.responseSchema.parse({
      selection: null,
      lastSelection: null,
    });
    expect(asNull.lastSelection).toBeNull();

    const absent = autoJudgeGetV12.responseSchema.parse({ selection: null });
    expect(Object.hasOwn(absent, "lastSelection")).toBe(false);

    const setAsObject = autoJudgeSetV12.responseSchema.parse({
      selection: null,
      lastSelection: selection,
    });
    expect(setAsObject.lastSelection).toEqual(selection);

    const setAsNull = autoJudgeSetV12.responseSchema.parse({
      selection: null,
      lastSelection: null,
    });
    expect(setAsNull.lastSelection).toBeNull();

    const setAbsent = autoJudgeSetV12.responseSchema.parse({
      selection: null,
    });
    expect(Object.hasOwn(setAbsent, "lastSelection")).toBe(false);
  });

  it("rejects a malformed lastSelection", () => {
    const emptyHarness = {
      selection: null,
      lastSelection: { harnessId: "", model: "m", profileId: null },
    };
    expect(autoJudgeGetV12.responseSchema.safeParse(emptyHarness).success).toBe(
      false,
    );
    expect(autoJudgeSetV12.responseSchema.safeParse(emptyHarness).success).toBe(
      false,
    );

    const asString = {
      selection: null,
      lastSelection: "not-a-selection",
    };
    expect(autoJudgeGetV12.responseSchema.safeParse(asString).success).toBe(
      false,
    );
    expect(autoJudgeSetV12.responseSchema.safeParse(asString).success).toBe(
      false,
    );
  });
});

describe("autoJudge.get/set 1.0 projection ignores lastSelection", () => {
  // Each `expected` is the answer the projection gave a 1.0 caller before
  // 1.2 existed, written out rather than recomputed, so a change to the
  // projection itself fails here and not only a leak of the new key.
  const cases: readonly {
    input: AutoJudgeGetResponse;
    expected: AutoJudgeGetResponseV10;
  }[] = [
    {
      input: {
        selection: null,
        effective: { source: "fallback" },
        blocked: null,
      },
      expected: {
        selection: null,
        effective: null,
        blocked: { reason: "provider-disabled" },
      },
    },
    {
      input: { selection, effective: selectionEffective, blocked: null },
      expected: { selection, effective: selectionEffective, blocked: null },
    },
    {
      input: {
        selection: null,
        effective: {
          harnessId: "traycer",
          model: "traycer-model",
          source: "default",
        },
        blocked: null,
      },
      expected: {
        selection: null,
        effective: {
          harnessId: "traycer",
          model: "traycer-model",
          source: "default",
        },
        blocked: null,
      },
    },
    {
      input: {
        selection,
        effective: null,
        blocked: { reason: "unsupported-harness" },
      },
      expected: {
        selection,
        effective: null,
        blocked: { reason: "unsupported-harness" },
      },
    },
    { input: { selection: null }, expected: { selection: null } },
  ];

  it("serves autoJudge.get's 1.0 caller today's answer whether lastSelection is present, null, or absent", () => {
    for (const { input, expected } of cases) {
      for (const lastSelection of [selection, null, undefined]) {
        const projected = projectAutoJudgeGetResponseToV10(
          lastSelection === undefined ? input : { ...input, lastSelection },
        );
        expect(projected).toStrictEqual(expected);
        expect(Object.hasOwn(projected, "lastSelection")).toBe(false);
        expect(
          autoJudgeGetV10.responseSchema.safeParse(projected).success,
        ).toBe(true);
      }
    }
  });

  it("does the same for autoJudge.set's echo", () => {
    for (const { input, expected } of cases) {
      const setInput: AutoJudgeSetResponse = input;
      const setExpected: AutoJudgeSetResponseV10 = expected;
      for (const lastSelection of [selection, null, undefined]) {
        const projected = projectAutoJudgeSetResponseToV10(
          lastSelection === undefined
            ? setInput
            : { ...setInput, lastSelection },
        );
        expect(projected).toStrictEqual(setExpected);
        expect(Object.hasOwn(projected, "lastSelection")).toBe(false);
        expect(
          autoJudgeSetV10.responseSchema.safeParse(projected).success,
        ).toBe(true);
      }
    }
  });
});

describe("autoJudge.get/set chained 1.0 -> 1.1 -> 1.2 upgrade", () => {
  it("has no lastSelection, and no-default still becomes unsupported-harness", () => {
    const v10: AutoJudgeGetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "no-default" },
    };
    const v11 = autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10);
    const v12 = autoJudgeGetUpgradeV11ToV12.upgradeResponse(v11);
    expect(Object.hasOwn(v12, "lastSelection")).toBe(false);
    expect(v12).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
    expect(autoJudgeGetV12.responseSchema.safeParse(v12).success).toBe(true);

    const setV10: AutoJudgeSetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "no-default" },
    };
    const setV11 = autoJudgeSetUpgradeV10ToV11.upgradeResponse(setV10);
    const setV12 = autoJudgeSetUpgradeV11ToV12.upgradeResponse(setV11);
    expect(Object.hasOwn(setV12, "lastSelection")).toBe(false);
    expect(setV12).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
  });
});
