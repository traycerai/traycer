import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Canary for the zod 4.4.3 internals `lazySchema` reconstructs in place.
 * Failures must name the new version so a bump cannot land silently.
 */

const requireFromHere = createRequire(import.meta.url);

function canaryMessage(version: string): string {
  return `lazySchema relies on zod 4.4.3 internals; zod is now ${version}: re-verify protocol/src/framework/lazy-schema.ts`;
}

function readZodPackageVersion(): string {
  const pkg: unknown = requireFromHere("zod/package.json");
  if (typeof pkg !== "object" || pkg === null) {
    throw new Error(canaryMessage("unreadable"));
  }
  const version = Reflect.get(pkg, "version");
  if (typeof version !== "string") {
    throw new Error(canaryMessage("unreadable"));
  }
  return version;
}

function readZod(schema: object): object {
  const internals: unknown = Reflect.get(schema, "_zod");
  if (typeof internals !== "object" || internals === null) {
    throw new Error(canaryMessage(readZodPackageVersion()));
  }
  return internals;
}

function readZodField(schema: object, field: string): unknown {
  return Reflect.get(readZod(schema), field);
}

function parseWith(schema: object, value: unknown): unknown {
  const parse = Reflect.get(schema, "parse");
  if (typeof parse !== "function") {
    throw new Error(canaryMessage(readZodPackageVersion()));
  }
  return Reflect.apply(parse, schema, [value]);
}

const ZOD_CLASSES = [
  z.ZodObject,
  z.ZodType,
  z.ZodEnum,
  z.ZodUnion,
  z.ZodDiscriminatedUnion,
  z.ZodString,
  z.ZodArray,
  z.ZodOptional,
  z.ZodNullable,
  z.ZodPipe,
  z.ZodLazy,
] as const;

describe("lazySchema zod 4.4.3 internals canary", () => {
  it("pins zod 4.4.3", () => {
    const version = readZodPackageVersion();
    expect(version, canaryMessage(version)).toBe("4.4.3");
  });

  it("_zod is an own non-enumerable bag of def, constr, traits and deferred", () => {
    const version = readZodPackageVersion();
    const built = z.object({ a: z.string() });
    const descriptor = Object.getOwnPropertyDescriptor(built, "_zod");
    expect(descriptor, canaryMessage(version)).toBeDefined();
    expect(descriptor?.enumerable, canaryMessage(version)).toBe(false);
    expect(typeof descriptor?.value, canaryMessage(version)).toBe("object");

    const def = readZodField(built, "def");
    expect(typeof def, canaryMessage(version)).toBe("object");
    expect(def, canaryMessage(version)).not.toBeNull();

    const constr = readZodField(built, "constr");
    expect(typeof constr, canaryMessage(version)).toBe("function");

    const traits = readZodField(built, "traits");
    expect(traits instanceof Set, canaryMessage(version)).toBe(true);

    const deferred = readZodField(built, "deferred");
    expect(Array.isArray(deferred), canaryMessage(version)).toBe(true);
  });

  it("constr.init is a function", () => {
    const version = readZodPackageVersion();
    const built = z.string();
    const constr = readZodField(built, "constr");
    if (typeof constr !== "function") {
      throw new Error(canaryMessage(version));
    }
    const init = Reflect.get(constr, "init");
    expect(typeof init, canaryMessage(version)).toBe("function");
  });

  it("each class has an own Symbol.hasInstance that answers by trait name", () => {
    const version = readZodPackageVersion();
    for (const cls of ZOD_CLASSES) {
      const descriptor = Object.getOwnPropertyDescriptor(
        cls,
        Symbol.hasInstance,
      );
      expect(descriptor, canaryMessage(version)).toBeDefined();
      expect(typeof descriptor?.value, canaryMessage(version)).toBe("function");
    }
    const object = z.object({ a: z.string() });
    expect(object instanceof z.ZodObject, canaryMessage(version)).toBe(true);
    expect(object instanceof z.ZodString, canaryMessage(version)).toBe(false);
    const traits = readZodField(object, "traits");
    if (!(traits instanceof Set)) {
      throw new Error(canaryMessage(version));
    }
    expect(traits.has("ZodObject"), canaryMessage(version)).toBe(true);
  });

  it("init + deferred on an empty object with the built prototype parses identically", () => {
    const version = readZodPackageVersion();
    const built = z.object({ a: z.string() });
    const standIn: object = {};
    Object.setPrototypeOf(standIn, Object.getPrototypeOf(built));
    const constr = readZodField(built, "constr");
    const def = readZodField(built, "def");
    if (typeof constr !== "function") {
      throw new Error(canaryMessage(version));
    }
    const init = Reflect.get(constr, "init");
    if (typeof init !== "function") {
      throw new Error(canaryMessage(version));
    }
    Reflect.apply(init, undefined, [standIn, def]);
    let deferred: unknown = readZodField(standIn, "deferred");
    if (deferred === undefined) {
      deferred = [];
      Reflect.set(readZod(standIn), "deferred", deferred);
    }
    if (!Array.isArray(deferred)) {
      throw new Error(canaryMessage(version));
    }
    for (const hook of deferred) {
      if (typeof hook === "function") {
        Reflect.apply(hook, undefined, []);
      }
    }
    expect(parseWith(standIn, { a: "x" }), canaryMessage(version)).toEqual(
      built.parse({ a: "x" }),
    );
  });

  it(".describe() sets _zod.parent", () => {
    const version = readZodPackageVersion();
    const base = z.string();
    const described = base.describe("labelled");
    expect(readZodField(described, "parent"), canaryMessage(version)).toBe(
      base,
    );
  });
});
