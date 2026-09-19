import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  lazySchema,
  lazySchemaStats,
} from "@traycer/protocol/framework/lazy-schema";
import {
  toJsonSchemaFingerprint,
  toStreamFieldJsonSchemaText,
  toUnknownKeyTree,
} from "@traycer/protocol/framework/json-schema-fingerprint";

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
  it("lazySchema(() => base.describe('x')) keeps the built instance's _zod.parent", () => {
    const base = z.string();
    const pending = lazySchema(() => base.describe("x"));
    void pending.parse;
    expect(readZodField(pending, "parent")).toBe(base);
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
    const pending = lazySchema(() => ({ not: "zod" }));
    expect(() => {
      void ("parse" in pending);
    }).toThrow(/did not return a zod 4 schema/);
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
