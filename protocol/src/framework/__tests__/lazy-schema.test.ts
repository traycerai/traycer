import { describe, expect, it } from "vitest";
import { describe as zodDescribe, meta as zodMeta, z } from "zod";
import {
  lazySchema,
  lazySchemaStats,
} from "@traycer/protocol/framework/lazy-schema";
import {
  toJsonSchemaFingerprint,
  toStreamFieldJsonSchemaText,
  toUnknownKeyTree,
} from "@traycer/protocol/framework/json-schema-fingerprint";

const titled = z.meta({ title: "T" });

function readZod(schema: object): object {
  const internals: unknown = Reflect.get(schema, "_zod");
  if (typeof internals !== "object" || internals === null) {
    throw new Error("schema has no _zod");
  }
  return internals;
}

function readZodField(schema: object, field: string): unknown {
  return Reflect.get(readZod(schema), field);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  throw new Error(`expected an Error, got ${String(value)}`);
}

type ParseSnapshot =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: ReadonlyArray<object> };

function snapshotIssue(issue: object): object {
  const snapshot: { [key: string]: unknown } = {};
  for (const key of Reflect.ownKeys(issue)) {
    if (typeof key !== "string") {
      continue;
    }
    const value = Reflect.get(issue, key);
    if (key === "path" && Array.isArray(value)) {
      snapshot[key] = [...value];
    } else {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function snapshotParse(
  result:
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: { readonly issues: ReadonlyArray<object> };
      },
): ParseSnapshot {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    issues: result.error.issues.map(snapshotIssue),
  };
}

async function expectEagerTwinIssues(
  init: () => z.ZodType,
  inputs: ReadonlyArray<unknown>,
): Promise<void> {
  for (const input of inputs) {
    const standIn = lazySchema(init);
    const twin = init();
    expect(snapshotParse(standIn.safeParse(input))).toEqual(
      snapshotParse(twin.safeParse(input)),
    );
    expect(snapshotParse(await standIn.safeParseAsync(input))).toEqual(
      snapshotParse(await twin.safeParseAsync(input)),
    );
  }
}

describe("lazySchema counting", () => {
  it("declared +1 per call; materialised waits for the first get / in / set", () => {
    const start = lazySchemaStats();
    const viaGet = lazySchema(() => z.string());
    const viaIn = lazySchema(() => z.string());
    const viaSet = lazySchema(() => z.string());
    expect(lazySchemaStats().declared).toBe(start.declared + 3);
    expect(lazySchemaStats().materialised).toBe(start.materialised);

    void viaGet.parse;
    expect(lazySchemaStats().materialised).toBe(start.materialised + 1);

    void ("parse" in viaIn);
    expect(lazySchemaStats().materialised).toBe(start.materialised + 2);

    expect(Reflect.set(viaSet, "marker", 1)).toBe(true);
    expect(lazySchemaStats().materialised).toBe(start.materialised + 3);

    void viaGet.parse;
    void viaGet.min;
    expect(lazySchemaStats().materialised).toBe(start.materialised + 3);
  });
});

describe("lazySchema identity", () => {
  it("the stand-in is the schema after a read, and is stored as itself in a parent shape", () => {
    const s = lazySchema(() => z.string());
    const parent = z.object({ a: s });
    expect(parent.shape.a).toBe(s);
    expect(s.parse("ok")).toBe("ok");
    expect(parent.shape.a).toBe(s);
    expect(s instanceof z.ZodString).toBe(true);
  });
});

describe("lazySchema pending operations", () => {
  it("extend / omit / pick / shape / parse / safeParse work on a pending object", () => {
    const pending = lazySchema(() =>
      z.object({ a: z.string(), b: z.number() }),
    );
    expect(
      pending.extend({ c: z.boolean() }).parse({ a: "x", b: 1, c: true }),
    ).toEqual({ a: "x", b: 1, c: true });

    const forOmit = lazySchema(() =>
      z.object({ a: z.string(), b: z.number() }),
    );
    expect(forOmit.omit({ b: true }).parse({ a: "x" })).toEqual({ a: "x" });

    const forPick = lazySchema(() =>
      z.object({ a: z.string(), b: z.number() }),
    );
    expect(forPick.pick({ a: true }).parse({ a: "x" })).toEqual({ a: "x" });

    const forShape = lazySchema(() =>
      z.object({ a: z.string(), b: z.number() }),
    );
    expect(Object.keys(forShape.shape).sort()).toEqual(["a", "b"]);

    const forParse = lazySchema(() => z.object({ a: z.string() }));
    expect(forParse.parse({ a: "x" })).toEqual({ a: "x" });
    const forSafe = lazySchema(() => z.object({ a: z.string() }));
    expect(forSafe.safeParse({ a: "x" }).success).toBe(true);
  });

  it("enum .options and codec z.encode work on a pending stand-in", () => {
    const pendingEnum = lazySchema(() => z.enum(["a", "b"]));
    expect(pendingEnum.options).toEqual(["a", "b"]);

    const codecInit = (): z.ZodCodec<z.ZodString, z.ZodNumber> =>
      z.codec(z.string(), z.number(), {
        decode: (value) => Number(value),
        encode: (value) => String(value),
      });
    const pendingCodec = lazySchema(codecInit);
    const twinCodec = codecInit();
    expect(z.encode(pendingCodec, 7)).toBe(z.encode(twinCodec, 7));
  });

  it("instanceof answers by the stand-in's own class, not another", () => {
    const objectS = lazySchema(() => z.object({ a: z.string() }));
    const stringS = lazySchema(() => z.string());
    const enumS = lazySchema(() => z.enum(["a"]));
    const unionS = lazySchema(() => z.union([z.string(), z.number()]));
    const discS = lazySchema(() =>
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a") }),
        z.object({ kind: z.literal("b") }),
      ]),
    );
    const arrayS = lazySchema(() => z.array(z.string()));
    const optionalS = lazySchema(() => z.string().optional());
    const nullableS = lazySchema(() => z.string().nullable());
    const pipeS = lazySchema(() => z.string().transform((value) => value));
    const lazyS = lazySchema(() => z.lazy(() => z.string()));

    expect(objectS instanceof z.ZodObject).toBe(true);
    expect(objectS instanceof z.ZodType).toBe(true);
    expect(objectS instanceof z.ZodString).toBe(false);

    expect(stringS instanceof z.ZodString).toBe(true);
    expect(stringS instanceof z.ZodObject).toBe(false);

    expect(enumS instanceof z.ZodEnum).toBe(true);
    expect(unionS instanceof z.ZodUnion).toBe(true);
    expect(discS instanceof z.ZodDiscriminatedUnion).toBe(true);
    expect(arrayS instanceof z.ZodArray).toBe(true);
    expect(optionalS instanceof z.ZodOptional).toBe(true);
    expect(nullableS instanceof z.ZodNullable).toBe(true);
    expect(pipeS instanceof z.ZodPipe).toBe(true);
    expect(lazyS instanceof z.ZodLazy).toBe(true);
  });

  it("pending object stand-in has the ZodObject trait", () => {
    const pending = lazySchema(() => z.object({ a: z.string() }));
    const traits = readZodField(pending, "traits");
    if (!(traits instanceof Set)) {
      throw new Error("traits is not a Set");
    }
    expect(traits.has("ZodObject")).toBe(true);
  });

  it("z.toJSONSchema on a pending stand-in deep-equals the twin", () => {
    const init = (): z.ZodObject => z.object({ a: z.string(), n: z.number() });
    const pending = lazySchema(init);
    const twin = init();
    expect(z.toJSONSchema(pending)).toEqual(z.toJSONSchema(twin));
  });
});

describe("lazySchema toJSONSchema pipe/codec child (seen.ref regression)", () => {
  it("z.toJSONSchema of a parent holding a pending piped child equals the eager twin", () => {
    const childInit = (): z.ZodPipe =>
      z.string().transform((value) => value.toUpperCase());
    const pendingChild = lazySchema(childInit);
    const eagerChild = childInit();
    expect(
      z.toJSONSchema(z.object({ a: pendingChild }), { unrepresentable: "any" }),
    ).toEqual(
      z.toJSONSchema(z.object({ a: eagerChild }), { unrepresentable: "any" }),
    );
  });

  it("z.toJSONSchema of a parent holding a pending codec child equals the eager twin", () => {
    const childInit = (): z.ZodCodec<z.ZodString, z.ZodString> =>
      z.codec(z.string(), z.string(), {
        decode: (value) => value,
        encode: (value) => value,
      });
    const pendingChild = lazySchema(childInit);
    const eagerChild = childInit();
    expect(z.toJSONSchema(z.object({ a: pendingChild }))).toEqual(
      z.toJSONSchema(z.object({ a: eagerChild })),
    );
  });
});

describe("lazySchema fingerprint helpers", () => {
  it("stream / unary / record fingerprint helpers match the twin", () => {
    const init = (): z.ZodObject =>
      z.object({ a: z.string(), nested: z.object({ n: z.number() }) });
    const pending = lazySchema(init);
    const twin = init();
    expect(toStreamFieldJsonSchemaText(pending)).toBe(
      toStreamFieldJsonSchemaText(twin),
    );
    expect(toJsonSchemaFingerprint(pending, "pending")).toEqual(
      toJsonSchemaFingerprint(twin, "twin"),
    );
    expect(toUnknownKeyTree(pending)).toEqual(toUnknownKeyTree(twin));
  });
});

describe("lazySchema documented pending vs built differences", () => {
  it("pending stand-in has no own keys and not the class prototype; a read fills keys; JSON.stringify materialises", () => {
    const init = (): z.ZodObject => z.object({ a: z.string() });
    const pending = lazySchema(init);
    const twin = init();
    expect(Object.keys(pending)).toEqual([]);
    expect({ ...pending }).toEqual({});
    expect(Object.getPrototypeOf(pending)).not.toBe(
      Object.getPrototypeOf(twin),
    );

    expect(JSON.stringify(pending)).toBe(JSON.stringify(twin));
    expect(Object.getPrototypeOf(pending)).toBe(Object.getPrototypeOf(twin));
    expect(Object.keys(pending).sort()).toEqual(Object.keys(twin).sort());
  });
});

describe("lazySchema deferred hooks", () => {
  it("a check-less schema has _zod.run === _zod.parse", () => {
    const pending = lazySchema(() => z.string());
    void pending.parse;
    expect(readZodField(pending, "run")).toBe(readZodField(pending, "parse"));
  });

  it("a checked schema enforces its check", () => {
    const pending = lazySchema(() => z.string().min(3));
    expect(() => pending.parse("ab")).toThrow();
    expect(pending.parse("abc")).toBe("abc");
  });
});

describe("lazySchema describe parent", () => {
  function expectGlobalRegistryRefusal(init: () => z.ZodType): void {
    let runs = 0;
    const pending = lazySchema(() => {
      runs += 1;
      return init();
    });
    const first = thrown(() => {
      void pending.parse;
    });
    expect(errorMessage(first)).toMatch(/global-registry metadata/);
    const second = thrown(() => {
      void pending.parse;
    });
    expect(second).toBe(first);
    expect(runs).toBe(1);
  }

  function expectCheckFormParity(init: () => z.ZodType): void {
    const standIn = lazySchema(init);
    const twin = init();
    expect(z.toJSONSchema(standIn)).toEqual(z.toJSONSchema(twin));
    expect(standIn.description).toBe(twin.description);
    expect(z.globalRegistry.get(standIn)).toEqual(z.globalRegistry.get(twin));
    expect(standIn.safeParse("ok").success).toBe(true);
    expect(twin.safeParse("ok").success).toBe(true);
    expect(standIn.safeParse(1).success).toBe(false);
    expect(twin.safeParse(1).success).toBe(false);
  }

  it("refuses outermost .describe; build runs once and later reads rethrow the same error", () => {
    const base = z.string();
    expectGlobalRegistryRefusal(() => base.describe("x"));
  });

  it("refuses outermost .meta and .register(z.globalRegistry); build runs once and later reads rethrow the same error", () => {
    expectGlobalRegistryRefusal(() => z.string().meta({ id: "M" }));
    expectGlobalRegistryRefusal(() =>
      z.string().register(z.globalRegistry, {}),
    );
  });

  it("check-form describe is not refused and matches the eager twin", () => {
    expectCheckFormParity(() => z.string().check(zodDescribe("x")));
  });

  it("with(meta({id})) is not refused and matches the eager twin", () => {
    expectCheckFormParity(() => z.string().with(zodMeta({ id: "M" })));
  });

  it("check(titled) at module-scope z.meta is not refused and matches the eager twin", () => {
    expectCheckFormParity(() => z.string().check(titled));
  });

  it("a check-described base followed by .min(3) is not refused and matches the eager twin", () => {
    const init = (): z.ZodType => z.string().check(z.describe("cb")).min(3);
    const standIn = lazySchema(init);
    const twin = init();
    expect(z.toJSONSchema(standIn)).toEqual(z.toJSONSchema(twin));
    expect(standIn.description).toBe(twin.description);
    expect(z.globalRegistry.get(standIn)).toEqual(z.globalRegistry.get(twin));
    expect(standIn.safeParse("abc").success).toBe(true);
    expect(twin.safeParse("abc").success).toBe(true);
    expect(standIn.safeParse("ab").success).toBe(false);
    expect(twin.safeParse("ab").success).toBe(false);
  });

  it("check-describe plus matching .register is not refused because the registry entries are equal", () => {
    expectCheckFormParity(() =>
      z
        .string()
        .check(z.describe("a"))
        .register(z.globalRegistry, { description: "a" }),
    );
  });

  it('check-describe then .describe("b") is refused fail-closed because the entries differ', () => {
    expectGlobalRegistryRefusal(() =>
      z.string().check(z.describe("a")).describe("b"),
    );
  });

  it("custom-registry .register is not refused; the stand-in is absent from the registry (documented limit the static scan covers)", () => {
    const reg = z.registry<{ n: number }>();
    const standIn = lazySchema(() => z.string().register(reg, { n: 1 }));
    expect(standIn.parse("ok")).toBe("ok");
    expect(reg.has(standIn)).toBe(false);
  });

  it("inner .describe is fine and z.toJSONSchema equals the eager twin", () => {
    const init = (): z.ZodObject => z.object({ a: z.string().describe("d") });
    const pending = lazySchema(init);
    expect(z.toJSONSchema(pending)).toEqual(z.toJSONSchema(init()));
  });
});

describe("lazySchema error paths", () => {
  it("self-reference while building throws", () => {
    const pending: z.ZodString = lazySchema(() => {
      void pending.parse;
      return z.string();
    });
    expect(() => pending.parse("x")).toThrow(
      /read while its own thunk was building it/,
    );
  });

  it("a thunk that throws once leaves the stand-in pending and the next read retries", () => {
    let attempts = 0;
    const pending = lazySchema(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boom");
      }
      return z.string();
    });
    expect(() => pending.parse("ok")).toThrow("boom");
    expect(pending.parse("ok")).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("a thunk returning a non-zod object throws", () => {
    const pending = lazySchema(() => ({ _zod: {} }));
    expect(() => {
      void ("parse" in pending);
    }).toThrow(/did not return a zod 4 schema/);
    // @ts-expect-error a thunk without `_zod` is not a zod 4 schema
    lazySchema(() => ({ notZod: true }));
  });

  it("z.instanceof outermost refuses bag.Class; later get/has/set rethrow the same error", () => {
    class Foo {}
    let builds = 0;
    const standIn = lazySchema(() => {
      builds += 1;
      return z.instanceof(Foo);
    });
    const before = lazySchemaStats();
    const first = thrown(() => {
      void standIn.parse;
    });
    expect(errorMessage(first)).toMatch(/_zod\.bag\.Class/);
    expect(errorMessage(first)).toMatch(/z\.instanceof/);
    const laterGet = thrown(() => {
      void standIn.safeParse;
    });
    const laterHas = thrown(() => {
      void ("parse" in standIn);
    });
    const laterSet = thrown(() => {
      Reflect.set(standIn, "marker", 1);
    });
    expect(laterGet).toBe(first);
    expect(laterHas).toBe(first);
    expect(laterSet).toBe(first);
    expect(builds).toBe(1);
    expect(lazySchemaStats().materialised).toBe(before.materialised);
    expect(Reflect.ownKeys(standIn)).toEqual(["_def"]);
  });

  it("a throw during in-place construction fail-closes with the same error and no leftover keys", () => {
    type SyntheticSchema = {
      readonly _zod: {
        readonly def: object;
        readonly constr: object;
      };
    };
    function syntheticConstr(): object {
      function constr(): void {}
      Object.defineProperty(constr, "init", {
        enumerable: false,
        value: (inst: object) => {
          Reflect.set(inst, "partial", 1);
          throw new Error("init boom");
        },
      });
      return constr;
    }
    let builds = 0;
    const standIn = lazySchema((): SyntheticSchema => {
      builds += 1;
      return { _zod: { def: {}, constr: syntheticConstr() } };
    });
    const before = lazySchemaStats();
    const first = thrown(() => {
      void Reflect.get(standIn, "partial");
    });
    expect(errorMessage(first)).toBe("init boom");
    const laterGet = thrown(() => {
      void Reflect.get(standIn, "partial");
    });
    const laterIn = thrown(() => {
      void ("x" in standIn);
    });
    const laterSet = thrown(() => {
      Reflect.set(standIn, "x", 1);
    });
    expect(laterGet).toBe(first);
    expect(laterIn).toBe(first);
    expect(laterSet).toBe(first);
    expect(Object.hasOwn(standIn, "partial")).toBe(false);
    expect(Reflect.ownKeys(standIn)).toEqual([]);
    expect(builds).toBe(1);
    expect(lazySchemaStats().materialised).toBe(before.materialised);
  });
});

describe("lazySchema receiver", () => {
  it("Object.create(standIn).extend caches on the child, not the stand-in, same as the eager twin; assignment through a child lands on the child", () => {
    const standIn = lazySchema(() => z.object({ a: z.string() }));
    const child: object = Object.create(standIn);
    void Reflect.get(child, "extend");
    expect(Object.hasOwn(child, "extend")).toBe(true);
    expect(Object.hasOwn(standIn, "extend")).toBe(false);

    const eager = z.object({ a: z.string() });
    const eagerChild: object = Object.create(eager);
    void Reflect.get(eagerChild, "extend");
    expect(Object.hasOwn(eagerChild, "extend")).toBe(true);
    expect(Object.hasOwn(eager, "extend")).toBe(false);

    const forAssign = lazySchema(() => z.object({ a: z.string() }));
    const assignChild: { x: number } = Object.create(forAssign);
    assignChild.x = 1;
    expect(Object.hasOwn(assignChild, "x")).toBe(true);
    expect(Object.hasOwn(forAssign, "x")).toBe(false);
  });
});

describe("lazySchema _zod descriptor", () => {
  it("after build, _zod is non-configurable, non-writable, non-enumerable, matching the eager twin", () => {
    const pending = lazySchema(() => z.object({ a: z.number() }));
    pending.parse({ a: 1 });
    const lazyDesc = Object.getOwnPropertyDescriptor(pending, "_zod");
    const eagerDesc = Object.getOwnPropertyDescriptor(
      z.object({ a: z.number() }),
      "_zod",
    );
    expect(lazyDesc).toBeDefined();
    expect(eagerDesc).toBeDefined();
    expect(lazyDesc?.configurable).toBe(false);
    expect(lazyDesc?.writable).toBe(false);
    expect(lazyDesc?.enumerable).toBe(false);
    expect(eagerDesc?.configurable).toBe(false);
    expect(eagerDesc?.writable).toBe(false);
    expect(eagerDesc?.enumerable).toBe(false);
  });
});

describe("lazySchema eager-twin failing inputs", () => {
  it("object .strict() with checks", async () => {
    await expectEagerTwinIssues(
      () =>
        z
          .object({
            a: z.string().min(2),
            n: z.number().int().nonnegative(),
          })
          .strict(),
      [
        {},
        { a: "x" },
        { a: "xy" },
        { a: "xy", n: -1 },
        { a: "xy", n: 1.5 },
        { a: "xy", n: 1, extra: true },
        { a: 1, n: 1 },
        null,
        "nope",
        [],
      ],
    );
  });

  it("discriminatedUnion", async () => {
    await expectEagerTwinIssues(
      () =>
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("cat"), lives: z.number().int() }),
          z.object({ kind: z.literal("dog"), good: z.boolean() }),
        ]),
      [
        {},
        { kind: "bird" },
        { kind: "cat" },
        { kind: "cat", lives: 1.5 },
        { kind: "dog" },
        { kind: "dog", good: "yes" },
        null,
        "nope",
      ],
    );
  });

  it("refine", async () => {
    await expectEagerTwinIssues(
      () =>
        z
          .number()
          .refine((value) => value % 2 === 0, { error: "must be even" }),
      [1, 3, "x", null, true, {}],
    );
  });

  it("transform+default", async () => {
    await expectEagerTwinIssues(
      () =>
        z
          .string()
          .transform((value) => value.toUpperCase())
          .default("n/a"),
      [1, null, true, {}, [], false],
    );
  });

  it("custom error map", async () => {
    await expectEagerTwinIssues(
      () =>
        z
          .string({
            error: (issue) => `mapped:${issue.code}`,
          })
          .min(4),
      [1, null, true, "", "abc", {}, []],
    );
  });

  it("array, record, and tuple", async () => {
    await expectEagerTwinIssues(
      () => z.array(z.number().int()),
      [["x"], [1.5], [1, "x"], null, {}, true, "nope"],
    );
    await expectEagerTwinIssues(
      () => z.record(z.string(), z.boolean()),
      [{ a: 1 }, { a: true, b: "x" }, null, [], "nope", 1],
    );
    await expectEagerTwinIssues(
      () => z.tuple([z.string(), z.number()]),
      [[], ["a"], ["a", "b"], ["a", 1, true], null, {}, "nope"],
    );
  });

  it("optional and nullable", async () => {
    await expectEagerTwinIssues(
      () =>
        z.object({
          opt: z.string().optional(),
          nul: z.number().nullable(),
        }),
      [
        {},
        { opt: 1 },
        { opt: null },
        { nul: "x" },
        { nul: undefined },
        { opt: "ok", nul: "x" },
        null,
        "nope",
      ],
    );
  });

  it("union", async () => {
    await expectEagerTwinIssues(
      () => z.union([z.string().email(), z.number().gt(10)]),
      ["", "not-email", 10, 0, true, null, {}, []],
    );
  });

  it("z.instanceof stand-in throws the bag.Class refusal while the eager twin reports invalid_type (finding-1 control)", () => {
    class Foo {}
    const init = (): z.ZodType => z.instanceof(Foo);
    const twin = init();
    for (const input of [42, "x", null, {}]) {
      const standIn = lazySchema(init);
      const refusal = thrown(() => {
        void standIn.safeParse(input);
      });
      expect(errorMessage(refusal)).toMatch(/_zod\.bag\.Class/);
      expect(errorMessage(refusal)).toMatch(/z\.instanceof/);
      const parsed = twin.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) {
        throw new Error("eager z.instanceof twin accepted a failing input");
      }
      const issues = parsed.error.issues;
      expect(issues.length).toBeGreaterThan(0);
      const firstIssue = issues[0];
      if (firstIssue === undefined) {
        throw new Error("eager z.instanceof twin produced no issues");
      }
      expect(firstIssue.code).toBe("invalid_type");
    }
  });
});

describe("lazySchema composition", () => {
  it("a discriminated union of pending options parses each option", () => {
    const a = lazySchema(() =>
      z.object({ kind: z.literal("a"), n: z.number() }),
    );
    const b = lazySchema(() =>
      z.object({ kind: z.literal("b"), s: z.string() }),
    );
    const union = z.discriminatedUnion("kind", [a, b]);
    expect(union.parse({ kind: "a", n: 1 })).toEqual({ kind: "a", n: 1 });
    expect(union.parse({ kind: "b", s: "x" })).toEqual({ kind: "b", s: "x" });
  });

  it("z.lazy(() => pending) works", () => {
    const pending = lazySchema(() => z.object({ a: z.string() }));
    const delayed = z.lazy(() => pending);
    expect(delayed.parse({ a: "x" })).toEqual({ a: "x" });
  });
});
