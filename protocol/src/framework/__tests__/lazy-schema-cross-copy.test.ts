import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Zod's `Symbol.hasInstance` answers by trait name, so a schema built by one
 * 4.4.3 copy is still `instanceof` another copy's classes. The helper relies
 * on that and has no copy-specific code; this file pins the zod behaviour for
 * a stand-in, not a helper-owned reconstruction path.
 */

const requireFromHere = createRequire(import.meta.url);

type ZodCopy = {
  readonly ZodObject: typeof z.ZodObject;
  readonly object: typeof z.object;
  readonly string: typeof z.string;
  readonly toJSONSchema: typeof z.toJSONSchema;
};

function loadSecondZodCopy(): ZodCopy {
  const pkg: unknown = requireFromHere("zod/package.json");
  if (typeof pkg !== "object" || pkg === null) {
    throw new Error("could not read zod/package.json");
  }
  const exportsField = Reflect.get(pkg, "exports");
  if (typeof exportsField !== "object" || exportsField === null) {
    throw new Error("zod package.json has no exports");
  }
  const rootExport = Reflect.get(exportsField, ".");
  if (typeof rootExport !== "object" || rootExport === null) {
    throw new Error("zod package.json exports['.'] missing");
  }
  const requirePath = Reflect.get(rootExport, "require");
  if (typeof requirePath !== "string") {
    throw new Error("zod package.json exports['.'].require missing");
  }
  const zodDir = path.dirname(requireFromHere.resolve("zod/package.json"));
  const cjsEntry = path.join(zodDir, requirePath);
  for (const key of Object.keys(requireFromHere.cache)) {
    if (key.includes("node_modules/zod") || key.includes("/zod/")) {
      delete requireFromHere.cache[key];
    }
  }
  const copyB: unknown = requireFromHere(cjsEntry);
  if (typeof copyB !== "object" || copyB === null) {
    throw new Error(`second zod copy was not an object from ${cjsEntry}`);
  }
  const ZodObject = Reflect.get(copyB, "ZodObject");
  const object = Reflect.get(copyB, "object");
  const string = Reflect.get(copyB, "string");
  const toJSONSchema = Reflect.get(copyB, "toJSONSchema");
  if (
    typeof ZodObject !== "function" ||
    typeof object !== "function" ||
    typeof string !== "function" ||
    typeof toJSONSchema !== "function"
  ) {
    throw new Error(`second zod copy from ${cjsEntry} is missing constructors`);
  }
  return {
    ZodObject: ZodObject as typeof z.ZodObject,
    object: object as typeof z.object,
    string: string as typeof z.string,
    toJSONSchema: toJSONSchema as typeof z.toJSONSchema,
  };
}

describe("zod trait-based instanceof across distinct 4.4.3 copies", () => {
  it("a stand-in built with copy B is instanceof copy A's class because traits match, which the helper relies on", () => {
    const copyB = loadSecondZodCopy();
    expect(copyB.ZodObject).not.toBe(z.ZodObject);

    const standInB = lazySchema(() => copyB.object({ a: copyB.string() }));
    expect(standInB instanceof z.ZodObject).toBe(true);

    const composed = z.object({ child: standInB });
    expect(composed.parse({ child: { a: "x" } })).toEqual({
      child: { a: "x" },
    });

    expect(z.toJSONSchema(standInB)).toEqual(
      z.toJSONSchema(z.object({ a: z.string() })),
    );
  });
});
