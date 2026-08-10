import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  findAdditivityViolation,
  toUnknownKeyTree,
  findBreakingChange,
  rootAdditivityViolation,
  toJsonSchemaFingerprint,
} from "../json-schema-fingerprint";

function fingerprint(schema: z.ZodType) {
  return toJsonSchemaFingerprint(schema, "test");
}

/**
 * Additivity = projection feasibility: the newer shape's payloads must
 * strip down through the older schema (unconditionally for old-form
 * payloads; new capabilities may refuse by design). Strict where
 * projection breaks unconditionally (removals, incompatible
 * replacements - at ANY depth), lenient where stripping or a designed
 * refusal handles it (additions and widenings - at ANY depth).
 */
describe("findAdditivityViolation - projection-feasibility semantics", () => {
  describe("additions are legal at any depth", () => {
    it("accepts a new top-level optional field", () => {
      const previous = fingerprint(z.object({ id: z.string() }));
      const next = fingerprint(
        z.object({ id: z.string(), note: z.string().optional() }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("accepts a new field nested inside an object property", () => {
      const previous = fingerprint(
        z.object({ agents: z.array(z.object({ id: z.string() })) }),
      );
      const next = fingerprint(
        z.object({
          agents: z.array(z.object({ id: z.string(), model: z.string() })),
        }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("accepts a new field inside a discriminated-union arm (array root)", () => {
      // The agent.listRunConfigs shape: array-of-union at the root. An
      // optional field added to one arm strips at projection, exactly
      // like a nested object addition - the old exact-fingerprint rule
      // wrongly priced this as breaking.
      const previous = fingerprint(
        z.array(
          z.discriminatedUnion("surface", [
            z.object({ surface: z.literal("gui"), model: z.string() }),
            z.object({ surface: z.literal("tui") }),
          ]),
        ),
      );
      const next = fingerprint(
        z.array(
          z.discriminatedUnion("surface", [
            z.object({
              surface: z.literal("gui"),
              model: z.string(),
              provenance: z.string().optional(),
            }),
            z.object({ surface: z.literal("tui") }),
          ]),
        ),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("accepts a brand-new union variant", () => {
      const previous = fingerprint(
        z.union([z.object({ kind: z.literal("a"), value: z.string() })]),
      );
      const next = fingerprint(
        z.union([
          z.object({ kind: z.literal("a"), value: z.string() }),
          z.object({ kind: z.literal("b"), other: z.number() }),
        ]),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("accepts new enum values", () => {
      const previous = fingerprint(z.object({ role: z.enum(["owner"]) }));
      const next = fingerprint(
        z.object({ role: z.enum(["owner", "editor"]) }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("treats the same addition identically under an object root and an array-union root", () => {
      // The old checker's strictness depended on the ROOT shape (objects
      // got a depth-1 check, array/union roots a full-depth one). The
      // walk is now uniform: both placements of the same addition pass.
      const objectRootPrevious = fingerprint(
        z.object({ rows: z.array(z.object({ id: z.string() })) }),
      );
      const objectRootNext = fingerprint(
        z.object({
          rows: z.array(z.object({ id: z.string(), extra: z.boolean() })),
        }),
      );
      const arrayRootPrevious = fingerprint(
        z.array(z.union([z.object({ id: z.string() })])),
      );
      const arrayRootNext = fingerprint(
        z.array(z.union([z.object({ id: z.string(), extra: z.boolean() })])),
      );
      expect(
        findAdditivityViolation(objectRootPrevious, objectRootNext, "lenient", null),
      ).toBeNull();
      expect(
        findAdditivityViolation(arrayRootPrevious, arrayRootNext, "lenient", null),
      ).toBeNull();
    });
  });

  describe("removals are violations at any depth", () => {
    it("flags a top-level field removal (unchanged behavior)", () => {
      const previous = fingerprint(
        z.object({ id: z.string(), trim: z.boolean() }),
      );
      const next = fingerprint(z.object({ id: z.string() }));
      expect(findAdditivityViolation(previous, next, "lenient", null)).toEqual({
        kind: "field",
        detail: "trim",
      });
    });

    it("flags a field removal nested inside an array of objects", () => {
      // The hole the shallow checker had: this passed validation while
      // breaking every old-peer projection at runtime.
      const previous = fingerprint(
        z.object({
          agents: z.array(z.object({ id: z.string(), model: z.string() })),
        }),
      );
      const next = fingerprint(
        z.object({ agents: z.array(z.object({ id: z.string() })) }),
      );
      // The array branch preserves the historical wrapping: violations
      // beneath an array surface as `array-items`, with the inner
      // violation (and its dotted path) in the description.
      expect(findAdditivityViolation(previous, next, "lenient", null)).toEqual({
        kind: "array-items",
        detail: "drops field 'agents.items.model'",
        inner: { kind: "field", detail: "agents.items.model" },
      });
    });

    it("flags a nested enum-value removal", () => {
      const previous = fingerprint(
        z.object({ settings: z.object({ role: z.enum(["owner", "viewer"]) }) }),
      );
      const next = fingerprint(
        z.object({ settings: z.object({ role: z.enum(["owner"]) }) }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toEqual({
        kind: "enum-value",
        detail: "viewer",
      });
    });

    it("flags a dropped union variant with no compatible successor", () => {
      const previous = fingerprint(
        z.union([
          z.object({ kind: z.literal("circle"), radius: z.number() }),
          z.object({ kind: z.literal("square"), side: z.number() }),
        ]),
      );
      const next = fingerprint(
        z.union([z.object({ kind: z.literal("circle"), radius: z.number() })]),
      );
      const violation = findAdditivityViolation(previous, next, "lenient", null);
      expect(violation?.kind).toBe("union-variant");
    });

    it("flags a variant whose replacement removed a field (not a compatible successor)", () => {
      const previous = fingerprint(
        z.union([
          z.object({ kind: z.literal("a"), value: z.string() }),
          z.object({ kind: z.literal("b") }),
        ]),
      );
      const next = fingerprint(
        z.union([
          z.object({ kind: z.literal("a") }),
          z.object({ kind: z.literal("b") }),
        ]),
      );
      const violation = findAdditivityViolation(previous, next, "lenient", null);
      expect(violation?.kind).toBe("union-variant");
    });
  });

  describe("widening lever", () => {
    it("accepts a nested field widening into a union that retains the old form", () => {
      // The sanctioned prepareLaunch@1.1 forkSource evolution: object ->
      // union-with-old-form. Previously legal only because the checker
      // could not see it; now legal because it is verified safe.
      const previous = fingerprint(
        z.object({ forkSource: z.object({ chatId: z.string() }) }),
      );
      const next = fingerprint(
        z.object({
          forkSource: z.union([
            z.object({ tuiAgentId: z.string() }),
            z.object({ chatId: z.string() }),
          ]),
        }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("flags a widening that abandons the old form", () => {
      const previous = fingerprint(
        z.object({ forkSource: z.object({ chatId: z.string() }) }),
      );
      const next = fingerprint(
        z.object({
          forkSource: z.union([
            z.object({ tuiAgentId: z.string() }),
            z.object({ sessionId: z.string() }),
          ]),
        }),
      );
      const violation = findAdditivityViolation(previous, next, "lenient", null);
      expect(violation?.kind).toBe("union-variant");
    });
  });

  describe("incompatible replacements", () => {
    it("flags a nested leaf type change", () => {
      const previous = fingerprint(z.object({ count: z.string() }));
      const next = fingerprint(z.object({ count: z.number() }));
      const violation = findAdditivityViolation(previous, next, "lenient", null);
      expect(violation?.kind).toBe("schema-kind");
      expect(violation?.detail).toContain("at 'count'");
    });

    it("flags a nested kind change from object to enum", () => {
      const previous = fingerprint(
        z.object({ mode: z.object({ id: z.string() }) }),
      );
      const next = fingerprint(z.object({ mode: z.enum(["fast", "slow"]) }));
      const violation = findAdditivityViolation(previous, next, "lenient", null);
      expect(violation?.kind).toBe("schema-kind");
    });

    it("still flags a root kind change", () => {
      const previous = fingerprint(z.object({ id: z.string() }));
      const next = fingerprint(z.array(z.object({ id: z.string() })));
      expect(findAdditivityViolation(previous, next, "lenient", null)).toEqual({
        kind: "schema-kind",
        detail: "object -> array",
      });
    });
  });

  describe("nullable and identical-leaf tolerance", () => {
    it("accepts unchanged nullable leaves (anyOf with null variant)", () => {
      const shape = z.object({ effort: z.string().nullable() });
      expect(
        findAdditivityViolation(fingerprint(shape), fingerprint(shape), "lenient", null),
      ).toBeNull();
    });

    it("accepts adding a field beside an untouched nullable field", () => {
      const previous = fingerprint(
        z.object({ effort: z.string().nullable() }),
      );
      const next = fingerprint(
        z.object({ effort: z.string().nullable(), fast: z.boolean() }),
      );
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });

    it("accepts widening a plain leaf to nullable (old form retained)", () => {
      const previous = fingerprint(z.object({ effort: z.string() }));
      const next = fingerprint(z.object({ effort: z.string().nullable() }));
      expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    });
  });
});

describe("findAdditivityViolation - no-value-growth mode (response lane)", () => {
  it("flags an enum-value addition that lenient mode accepts", () => {
    const previous = fingerprint(z.object({ role: z.enum(["owner"]) }));
    const next = fingerprint(z.object({ role: z.enum(["owner", "editor"]) }));
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    expect(findAdditivityViolation(previous, next, "no-value-growth", null)).toEqual({
      kind: "enum-value-added",
      detail: "editor",
    });
  });

  it("flags a brand-new union variant that lenient mode accepts", () => {
    const previous = fingerprint(
      z.union([z.object({ kind: z.literal("a"), value: z.string() })]),
    );
    const next = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), value: z.string() }),
        z.object({ kind: z.literal("b"), other: z.number() }),
      ]),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    const strict = findAdditivityViolation(previous, next, "no-value-growth", null);
    expect(strict?.kind).toBe("union-variant-added");
  });

  it("flags widening a leaf to nullable (null is a value an old schema refuses)", () => {
    const previous = fingerprint(z.object({ effort: z.string() }));
    const next = fingerprint(z.object({ effort: z.string().nullable() }));
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    const strict = findAdditivityViolation(previous, next, "no-value-growth", null);
    expect(strict?.kind).toBe("union-variant-added");
  });

  it("still accepts pure structural additions - new keys strip regardless of their contents", () => {
    const previous = fingerprint(z.object({ id: z.string() }));
    // The new key's subtree may contain enums/unions freely: the old
    // schema strips the whole key, so its contents are unreachable.
    const next = fingerprint(
      z.object({
        id: z.string(),
        status: z.enum(["queued", "running"]).optional(),
      }),
    );
    expect(
      findAdditivityViolation(previous, next, "no-value-growth", null),
    ).toBeNull();
  });

  it("still accepts extending an existing union arm with a new optional field", () => {
    const previous = fingerprint(
      z.array(
        z.discriminatedUnion("surface", [
          z.object({ surface: z.literal("gui"), model: z.string() }),
          z.object({ surface: z.literal("tui") }),
        ]),
      ),
    );
    const next = fingerprint(
      z.array(
        z.discriminatedUnion("surface", [
          z.object({
            surface: z.literal("gui"),
            model: z.string(),
            provenance: z.string().optional(),
          }),
          z.object({ surface: z.literal("tui") }),
        ]),
      ),
    );
    expect(
      findAdditivityViolation(previous, next, "no-value-growth", null),
    ).toBeNull();
  });

  it("surfaces nested enum growth inside a surviving union arm as the precise violation", () => {
    const previous = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), mode: z.enum(["x"]) }),
        z.object({ kind: z.literal("b") }),
      ]),
    );
    const next = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), mode: z.enum(["x", "y"]) }),
        z.object({ kind: z.literal("b") }),
      ]),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    expect(findAdditivityViolation(previous, next, "no-value-growth", null)).toEqual({
      kind: "enum-value-added",
      detail: "y",
    });
  });

  it("keeps enforcing structural safety identically in strict mode", () => {
    const previous = fingerprint(
      z.object({ agents: z.array(z.object({ id: z.string(), m: z.string() })) }),
    );
    const next = fingerprint(
      z.object({ agents: z.array(z.object({ id: z.string() })) }),
    );
    expect(
      findAdditivityViolation(previous, next, "no-value-growth", null),
    ).toEqual({
      kind: "array-items",
      detail: "drops field 'agents.items.m'",
      inner: { kind: "field", detail: "agents.items.m" },
    });
  });
});

describe("findAdditivityViolation - review-hardening cases", () => {
  it("flags relaxing a required field to optional inside a union arm", () => {
    // Compatibility-based variant matching must not lose requiredness: both
    // arms keep identical `properties`, so only the `required` arrays differ,
    // and a newer peer omitting the field fails the older schema outright.
    const previous = fingerprint(
      z.union([z.object({ kind: z.literal("a"), value: z.string() })]),
    );
    const next = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), value: z.string().optional() }),
      ]),
    );
    const violation = findAdditivityViolation(previous, next, "lenient", null);
    expect(violation?.kind).toBe("union-variant");
  });

  it("flags relaxing a required field to optional on a plain object", () => {
    const previous = fingerprint(z.object({ id: z.string() }));
    const next = fingerprint(z.object({ id: z.string().optional() }));
    expect(findAdditivityViolation(previous, next, "lenient", null)).toEqual({
      kind: "required-field",
      detail: "id",
    });
  });

  it("accepts annotation-only leaf changes (default/description)", () => {
    // `default` and friends annotate a leaf without changing the value set
    // it accepts, so a newer peer's payloads still project. Zod keeps a
    // defaulted field in `required` (it emits the output shape), so this is
    // purely a leaf-annotation question, not a requiredness one.
    const previous = fingerprint(z.object({ id: z.string() }));
    const next = fingerprint(
      z.object({ id: z.string().default("x").describe("the id") }),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    expect(
      findAdditivityViolation(previous, next, "no-value-growth", null),
    ).toBeNull();
  });


  it("accepts narrowing a scalar constraint", () => {
    // Every value the newer schema emits is still accepted by the older one.
    const previous = fingerprint(z.object({ s: z.string().max(10) }));
    const next = fingerprint(z.object({ s: z.string().max(5) }));
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
  });

  it("accepts adding a bound the older side did not have", () => {
    const previous = fingerprint(z.object({ s: z.string() }));
    const next = fingerprint(z.object({ s: z.string().max(5) }));
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
  });

  it("rejects widening a scalar constraint", () => {
    const previous = fingerprint(z.object({ s: z.string().max(5) }));
    const next = fingerprint(z.object({ s: z.string().max(10) }));
    const violation = findAdditivityViolation(previous, next, "lenient", null);
    expect(violation?.kind).toBe("schema-kind");
  });

  it("rejects dropping a bound the older side enforced", () => {
    const previous = fingerprint(z.object({ s: z.string().min(3) }));
    const next = fingerprint(z.object({ s: z.string() }));
    const violation = findAdditivityViolation(previous, next, "lenient", null);
    expect(violation?.kind).toBe("schema-kind");
  });

  it("narrows lower bounds in the opposite direction", () => {
    const previous = fingerprint(z.object({ n: z.number().min(1) }));
    const wider = fingerprint(z.object({ n: z.number().min(0) }));
    const narrower = fingerprint(z.object({ n: z.number().min(5) }));
    expect(findAdditivityViolation(previous, narrower, "lenient", null)).toBeNull();
    expect(
      findAdditivityViolation(previous, wider, "lenient", null),
    ).not.toBeNull();
  });

  it("still flags a constraining leaf change", () => {
    const previous = fingerprint(z.object({ id: z.string() }));
    const next = fingerprint(z.object({ id: z.number() }));
    const violation = findAdditivityViolation(previous, next, "lenient", null);
    expect(violation?.kind).toBe("schema-kind");
  });

  it("flags an added arm that differs from an existing one only by value growth", () => {
    // previous [A]; next [A, A'] where A' is A plus an enum value. A survives
    // strictly, so the added-arm probe must also run strictly or A' escapes.
    const previous = fingerprint(
      z.union([z.object({ kind: z.literal("a"), mode: z.enum(["x"]) })]),
    );
    const next = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), mode: z.enum(["x"]) }),
        z.object({ kind: z.literal("a"), mode: z.enum(["x", "y"]) }),
      ]),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    const strict = findAdditivityViolation(previous, next, "no-value-growth", null);
    expect(strict?.kind).toBe("union-variant-added");
  });

  it("accepts a union collapse where every old arm still projects", () => {
    // Two DISTINCT arms that both genuinely project onto the replacement:
    // every payload the collapsed schema can emit is still accepted by one
    // of the old arms. (Note `[{id}, {name}]` -> `{id?, name?}` would NOT
    // qualify - the collapsed form can emit `{}`, which neither old arm
    // accepts - so it is correctly rejected rather than used here.)
    const previous = fingerprint(
      z.union([
        z.object({ id: z.string(), kind: z.literal("a") }),
        z.object({ id: z.string(), kind: z.literal("b") }),
      ]),
    );
    const next = fingerprint(
      z.object({ id: z.string(), kind: z.enum(["a", "b"]) }),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
  });

  it("flags a union collapse that abandons an arm", () => {
    const previous = fingerprint(
      z.union([
        z.object({ kind: z.literal("a"), value: z.string() }),
        z.object({ kind: z.literal("b"), other: z.number() }),
      ]),
    );
    const next = fingerprint(
      z.object({ kind: z.literal("a"), value: z.string() }),
    );
    const violation = findAdditivityViolation(previous, next, "lenient", null);
    expect(violation?.kind).toBe("union-variant");
  });

  it("preserves the inner violation structurally under array-items", () => {
    const previous = fingerprint(
      z.object({ rows: z.array(z.object({ status: z.enum(["queued"]) })) }),
    );
    const next = fingerprint(
      z.object({
        rows: z.array(z.object({ status: z.enum(["queued", "running"]) })),
      }),
    );
    const violation = findAdditivityViolation(previous, next, "no-value-growth", null);
    expect(violation?.kind).toBe("array-items");
    expect(
      violation !== null && violation.kind === "array-items"
        ? rootAdditivityViolation(violation)
        : null,
    ).toEqual({ kind: "enum-value-added", detail: "running" });
  });
});


describe("strict objects reject growth", () => {
  it("flags adding a field when the older object is strict", () => {
    // A stripping object drops the unknown key; a strict one rejects the
    // whole payload, so this addition breaks projection for EVERY payload.
    const previousSchema = z.strictObject({ a: z.string() });
    const previous = fingerprint(previousSchema);
    const next = fingerprint(
      z.strictObject({ a: z.string(), b: z.string().optional() }),
    );
    expect(
      findAdditivityViolation(
        previous,
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).toEqual({ kind: "strict-object-growth", detail: "b" });
  });

  it("still accepts the same addition on a stripping object", () => {
    const previousSchema = z.object({ a: z.string() });
    const previous = fingerprint(previousSchema);
    const next = fingerprint(
      z.object({ a: z.string(), b: z.string().optional() }),
    );
    expect(
      findAdditivityViolation(
        previous,
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).toBeNull();
  });

  it("flags growth of a strict union arm", () => {
    const previousSchema = z.union([
      z.strictObject({ kind: z.literal("a"), value: z.string() }),
    ]);
    const previous = fingerprint(previousSchema);
    const next = fingerprint(
      z.union([
        z.strictObject({
          kind: z.literal("a"),
          value: z.string(),
          extra: z.string().optional(),
        }),
      ]),
    );
    const violation = findAdditivityViolation(
      previous,
      next,
      "lenient",
      toUnknownKeyTree(previousSchema),
    );
    expect(violation).not.toBeNull();
  });


  it("allows growth of the STRIPPING arm of a mixed union", () => {
    const previousSchema = z.union([
      z.strictObject({ kind: z.literal("a"), a: z.string() }),
      z.object({ kind: z.literal("b"), b: z.string() }),
    ]);
    const next = fingerprint(
      z.union([
        z.strictObject({ kind: z.literal("a"), a: z.string() }),
        z.object({
          kind: z.literal("b"),
          b: z.string(),
          extra: z.string().optional(),
        }),
      ]),
    );
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).toBeNull();
  });

  it("rejects growth of the STRICT arm of the same mixed union", () => {
    // Per-arm tracking: a path-level flag could not tell these two cases
    // apart and had to choose one wrong answer.
    const previousSchema = z.union([
      z.strictObject({ kind: z.literal("a"), a: z.string() }),
      z.object({ kind: z.literal("b"), b: z.string() }),
    ]);
    const next = fingerprint(
      z.union([
        z.strictObject({
          kind: z.literal("a"),
          a: z.string(),
          extra: z.string().optional(),
        }),
        z.object({ kind: z.literal("b"), b: z.string() }),
      ]),
    );
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).not.toBeNull();
  });

  it("allows an addition that SATISFIES a typed catchall", () => {
    // The old schema already accepts `b` through its string catchall, so
    // projection is feasible and forcing a major would be wrong.
    const previousSchema = z.object({ a: z.string() }).catchall(z.string());
    const next = fingerprint(
      z.object({ a: z.string(), b: z.string() }).catchall(z.string()),
    );
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).toBeNull();
  });

  it("rejects an addition that VIOLATES a typed catchall", () => {
    const previousSchema = z.object({ a: z.string() }).catchall(z.string());
    const next = fingerprint(
      z.object({ a: z.string(), b: z.number() }).catchall(z.string()),
    );
    const violation = findAdditivityViolation(
      fingerprint(previousSchema),
      next,
      "lenient",
      toUnknownKeyTree(previousSchema),
    );
    expect(violation?.kind).toBe("strict-object-growth");
  });

  it("treats a permissive catchall as strip-equivalent", () => {
    const previousSchema = z.object({ a: z.string() }).catchall(z.unknown());
    const next = fingerprint(
      z.object({ a: z.string(), b: z.string() }).catchall(z.unknown()),
    );
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        next,
        "lenient",
        toUnknownKeyTree(previousSchema),
      ),
    ).toBeNull();
  });

  it("detects strictness nested under a property and an array", () => {
    const previousSchema = z.object({
      rows: z.array(z.strictObject({ id: z.string() })),
      loose: z.object({ id: z.string() }),
    });
    const input = toUnknownKeyTree(previousSchema);
    // Strict arm nested under an array: growth rejected.
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        fingerprint(
          z.object({
            rows: z.array(
              z.strictObject({ id: z.string(), extra: z.string() }),
            ),
            loose: z.object({ id: z.string() }),
          }),
        ),
        "lenient",
        input,
      ),
    ).not.toBeNull();
    // Stripping sibling under a property: growth still allowed.
    expect(
      findAdditivityViolation(
        fingerprint(previousSchema),
        fingerprint(
          z.object({
            rows: z.array(z.strictObject({ id: z.string() })),
            loose: z.object({ id: z.string(), extra: z.string() }),
          }),
        ),
        "lenient",
        input,
      ),
    ).toBeNull();
  });
});

describe("findBreakingChange - major-justification interplay", () => {
  it("still justifies a major for nested enum growth (shipped agent.list precedent)", () => {
    // agent.list v1->v7 majors are justified purely by nested harnessId
    // enum growth through the per-property structural comparison; the
    // additivity rework must not invalidate that shipped history.
    const previous = fingerprint(
      z.object({ agents: z.array(z.object({ harness: z.enum(["a"]) })) }),
    );
    const next = fingerprint(
      z.object({ agents: z.array(z.object({ harness: z.enum(["a", "b"]) })) }),
    );
    expect(findAdditivityViolation(previous, next, "lenient", null)).toBeNull();
    expect(findBreakingChange(previous, next)).not.toBeNull();
  });

  it("reports a nested removal as a removed-field breaking change", () => {
    const previous = fingerprint(
      z.object({ agents: z.array(z.object({ id: z.string(), m: z.string() })) }),
    );
    const next = fingerprint(
      z.object({ agents: z.array(z.object({ id: z.string() })) }),
    );
    const breaking = findBreakingChange(previous, next);
    expect(breaking?.reason).toBe("removed");
  });
});
