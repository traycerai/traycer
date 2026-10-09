/**
 * `host-lifecycle-policy.ts`: the record's path helper, round-trip through
 * serialize/parse, and the "malformed reads as absent, never throws"
 * contract that {@link parseHostLifecyclePolicy} / {@link
 * parseHostLifecyclePolicyText} promise every caller in this directory.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_LIFECYCLE_DEFAULT_MODE,
  HOST_LIFECYCLE_MODES,
  effectiveHostLifecycleMode,
  hostLifecyclePolicyPath,
  parseHostLifecyclePolicy,
  parseHostLifecyclePolicyText,
  refreshOnModeChange,
  serializeHostLifecyclePolicy,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "../host-lifecycle-policy";

describe("hostLifecyclePolicyPath", () => {
  it("joins the filename onto the given host home directory", () => {
    expect(hostLifecyclePolicyPath("/fake/host-home")).toBe(
      join("/fake/host-home", "lifecycle-policy.json"),
    );
  });

  it("resolves relative to whatever directory it is given", () => {
    expect(hostLifecyclePolicyPath("/one/slot")).toBe(
      join("/one/slot", "lifecycle-policy.json"),
    );
    expect(hostLifecyclePolicyPath("/another/slot")).toBe(
      join("/another/slot", "lifecycle-policy.json"),
    );
  });
});

const VALID_POLICY: HostLifecyclePolicy = {
  v: 1,
  rev: 3,
  mode: "linked",
  updatedAt: "2026-08-17T12:00:00.000Z",
  updatedBy: "desktop",
};

describe("serialize / parse round-trip", () => {
  it("parseHostLifecyclePolicyText(serializeHostLifecyclePolicy(x)) returns x", () => {
    const text = serializeHostLifecyclePolicy(VALID_POLICY);
    expect(parseHostLifecyclePolicyText(text)).toEqual(VALID_POLICY);
  });

  it("the serialized text ends with a newline", () => {
    const text = serializeHostLifecyclePolicy(VALID_POLICY);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("every mode in HOST_LIFECYCLE_MODES round-trips", () => {
    for (const mode of HOST_LIFECYCLE_MODES) {
      const policy: HostLifecyclePolicy = { ...VALID_POLICY, mode };
      const text = serializeHostLifecyclePolicy(policy);
      expect(parseHostLifecyclePolicyText(text)).toEqual(policy);
    }
  });
});

describe("malformed input reads as absent, never throws", () => {
  const withoutV = {
    rev: VALID_POLICY.rev,
    mode: VALID_POLICY.mode,
    updatedAt: VALID_POLICY.updatedAt,
    updatedBy: VALID_POLICY.updatedBy,
  };
  const withoutRev = {
    v: VALID_POLICY.v,
    mode: VALID_POLICY.mode,
    updatedAt: VALID_POLICY.updatedAt,
    updatedBy: VALID_POLICY.updatedBy,
  };
  const withoutMode = {
    v: VALID_POLICY.v,
    rev: VALID_POLICY.rev,
    updatedAt: VALID_POLICY.updatedAt,
    updatedBy: VALID_POLICY.updatedBy,
  };
  const withoutUpdatedAt = {
    v: VALID_POLICY.v,
    rev: VALID_POLICY.rev,
    mode: VALID_POLICY.mode,
    updatedBy: VALID_POLICY.updatedBy,
  };
  const withoutUpdatedBy = {
    v: VALID_POLICY.v,
    rev: VALID_POLICY.rev,
    mode: VALID_POLICY.mode,
    updatedAt: VALID_POLICY.updatedAt,
  };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly value: unknown;
  }> = [
    { name: "a string", value: "not-a-record" },
    { name: "a number", value: 42 },
    { name: "a boolean", value: true },
    { name: "null", value: null },
    { name: "an array", value: [] },
    { name: "wrong v: 0", value: { ...VALID_POLICY, v: 0 } },
    { name: "wrong v: 2", value: { ...VALID_POLICY, v: 2 } },
    { name: 'wrong v: "1"', value: { ...VALID_POLICY, v: "1" } },
    { name: "missing v", value: withoutV },
    { name: "missing rev", value: withoutRev },
    { name: "missing mode", value: withoutMode },
    { name: "missing updatedAt", value: withoutUpdatedAt },
    { name: "missing updatedBy", value: withoutUpdatedBy },
    { name: "rev as a string", value: { ...VALID_POLICY, rev: "3" } },
    { name: "mode as a number", value: { ...VALID_POLICY, mode: 1 } },
    { name: "updatedAt as a number", value: { ...VALID_POLICY, updatedAt: 1 } },
    { name: "updatedBy as a number", value: { ...VALID_POLICY, updatedBy: 1 } },
    { name: "rev negative", value: { ...VALID_POLICY, rev: -1 } },
    { name: "rev non-integer", value: { ...VALID_POLICY, rev: 1.5 } },
    { name: "rev NaN", value: { ...VALID_POLICY, rev: Number.NaN } },
    {
      name: "rev Infinity",
      value: { ...VALID_POLICY, rev: Number.POSITIVE_INFINITY },
    },
    {
      name: "an unparseable updatedAt",
      value: { ...VALID_POLICY, updatedAt: "not-a-date" },
    },
  ];

  for (const testCase of cases) {
    it(`parseHostLifecyclePolicy returns null for ${testCase.name}`, () => {
      expect(() => parseHostLifecyclePolicy(testCase.value)).not.toThrow();
      expect(parseHostLifecyclePolicy(testCase.value)).toBeNull();
    });

    it(`parseHostLifecyclePolicyText returns null for ${testCase.name}`, () => {
      const text = JSON.stringify(testCase.value);
      expect(() => parseHostLifecyclePolicyText(text)).not.toThrow();
      expect(parseHostLifecyclePolicyText(text)).toBeNull();
    });
  }

  const textOnlyCases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
  }> = [
    { name: "an empty string", text: "" },
    { name: "truncated JSON", text: '{"v":1,"rev":' },
    { name: "non-JSON text", text: "not json at all" },
  ];

  for (const testCase of textOnlyCases) {
    it(`parseHostLifecyclePolicyText returns null for ${testCase.name}`, () => {
      expect(() => parseHostLifecyclePolicyText(testCase.text)).not.toThrow();
      expect(parseHostLifecyclePolicyText(testCase.text)).toBeNull();
    });
  }
});

describe("enum rejection", () => {
  it("reads an unknown mode as absent, never as the mode it does not know", () => {
    for (const mode of ["linked-v2", "Background", ""]) {
      expect(parseHostLifecyclePolicy({ ...VALID_POLICY, mode })).toBeNull();
    }
  });

  it("reads an unknown updatedBy as absent", () => {
    for (const updatedBy of ["cli-v2", "Desktop", ""]) {
      expect(
        parseHostLifecyclePolicy({ ...VALID_POLICY, updatedBy }),
      ).toBeNull();
    }
  });
});

describe("unknown extra keys are ignored", () => {
  it("still parses and drops the extra key", () => {
    const withExtra = { ...VALID_POLICY, someFutureField: "unexpected" };
    const parsed = parseHostLifecyclePolicy(withExtra);
    expect(parsed).toEqual(VALID_POLICY);
    expect(parsed).not.toBeNull();
    expect(parsed && "someFutureField" in parsed).toBe(false);
  });
});

/**
 * `refreshOnModeChange`: exhaustive over all 25 `(previous, next)` mode
 * pairs (`HOST_LIFECYCLE_MODES.length ** 2`), hardcoded rather than
 * re-derived from `previous !== next && next !== "background"` - the same
 * expression the implementation uses - so this table catches a refactor
 * that keeps the code "looking right" while changing what it actually
 * computes (e.g. flipping to `previous === next || next === "background"`,
 * or keying off `previous` instead of `next` for the Background exclusion).
 */
const MODE_PAIR_EXPECTATIONS: ReadonlyArray<
  readonly [HostLifecycleMode, HostLifecycleMode, boolean]
> = [
  ["background", "background", false],
  ["background", "linked", true],
  ["background", "ask", true],
  ["background", "stop-if-idle", true],
  ["background", "none", true],
  ["linked", "background", false],
  ["linked", "linked", false],
  ["linked", "ask", true],
  ["linked", "stop-if-idle", true],
  ["linked", "none", true],
  ["ask", "background", false],
  ["ask", "linked", true],
  ["ask", "ask", false],
  ["ask", "stop-if-idle", true],
  ["ask", "none", true],
  ["stop-if-idle", "background", false],
  ["stop-if-idle", "linked", true],
  ["stop-if-idle", "ask", true],
  ["stop-if-idle", "stop-if-idle", false],
  ["stop-if-idle", "none", true],
  ["none", "background", false],
  ["none", "linked", true],
  ["none", "ask", true],
  ["none", "stop-if-idle", true],
  ["none", "none", false],
];

describe("refreshOnModeChange", () => {
  it("the table above covers every one of the 25 (previous, next) pairs exactly once", () => {
    expect(MODE_PAIR_EXPECTATIONS.length).toBe(
      HOST_LIFECYCLE_MODES.length ** 2,
    );
    const seen = new Set(
      MODE_PAIR_EXPECTATIONS.map(([previous, next]) => `${previous}->${next}`),
    );
    expect(seen.size).toBe(MODE_PAIR_EXPECTATIONS.length);
    for (const previous of HOST_LIFECYCLE_MODES) {
      for (const next of HOST_LIFECYCLE_MODES) {
        expect(seen.has(`${previous}->${next}`)).toBe(true);
      }
    }
  });

  it.each(MODE_PAIR_EXPECTATIONS)(
    "(%s -> %s) = %s",
    (previous, next, expected) => {
      expect(refreshOnModeChange(previous, next)).toBe(expected);
    },
  );

  it("is false for every mode re-set onto itself (the diagonal): re-choosing the mode already in force is not a transition", () => {
    for (const mode of HOST_LIFECYCLE_MODES) {
      expect(refreshOnModeChange(mode, mode)).toBe(false);
    }
  });

  it("is false whenever `next` is background, regardless of `previous`: background parks nothing, so it needs no refresh", () => {
    for (const previous of HOST_LIFECYCLE_MODES) {
      expect(refreshOnModeChange(previous, "background")).toBe(false);
    }
  });

  it("is true for every OTHER transition into a non-background mode, `none` included", () => {
    for (const previous of HOST_LIFECYCLE_MODES) {
      for (const next of HOST_LIFECYCLE_MODES) {
        if (previous === next || next === "background") continue;
        expect(refreshOnModeChange(previous, next)).toBe(true);
      }
    }
  });
});

describe("effectiveHostLifecycleMode", () => {
  it("is background for a null policy", () => {
    expect(effectiveHostLifecycleMode(null)).toBe("background");
  });

  it("HOST_LIFECYCLE_DEFAULT_MODE is background", () => {
    expect(HOST_LIFECYCLE_DEFAULT_MODE).toBe("background");
  });

  it("is the record's mode when one is present", () => {
    expect(effectiveHostLifecycleMode(VALID_POLICY)).toBe("linked");
  });
});
