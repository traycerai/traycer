/**
 * `lazySchema(build)` returns a stand-in for the zod 4 schema `build` returns,
 * typed as that schema, and runs `build` the first time anything reads the
 * stand-in. Until then no zod instance of that initialiser exists.
 *
 * Why: a zod 4 instance is a dictionary-mode object carrying dozens of
 * per-instance closures, and the protocol declares every frozen version of
 * every contract at module scope, so a process that imports a registry built
 * all of them at import although a connection negotiates one version per
 * method.
 *
 * The stand-in is NOT a Proxy around the schema. zod binds each instance's
 * internals to that instance (`_zod.run`, `_zod.processJSONSchema`, the
 * methods) while a parent holds whatever reference it was given, and its JSON
 * Schema conversion keys a `seen` map by instance: a Proxy in the parent and
 * the real instance in the closures are two keys, and `z.toJSONSchema` fails.
 * So the stand-in BECOMES the schema. It starts as an empty object whose
 * prototype is a trigger Proxy; the first read that reaches the prototype (a
 * property get, `in`, or an assignment) runs `build`, gives the stand-in the
 * built schema's class prototype, and runs zod's own construction on it in
 * place: `_zod.constr.init(standIn, def)`, then the `_zod.deferred` hooks,
 * which is exactly what `new` does (`zod/v4/core/core.js`, `$constructor`).
 * From then on the stand-in is an ordinary zod instance whose closures are
 * bound to itself; the trigger is out of its prototype chain, so parsing pays
 * nothing. The instance `build` returned is discarded; its children are
 * shared through `def`.
 *
 * `instanceof` goes through each zod class's `Symbol.hasInstance`, which
 * reads `_zod.traits` and so materialises a pending stand-in first.
 * `lazy-schema-zod-internals.test.ts` fails if a zod upgrade changes any of
 * the internals this relies on.
 *
 * What a PENDING stand-in does not do: it has no own keys, so
 * `Object.keys`, a spread or `structuredClone` of a stand-in nobody has read
 * yet sees an empty object, and `Object.getPrototypeOf` returns the trigger.
 * No code reads a schema that way; the tests pin the scan that says so.
 *
 * `build` must enclose the whole initialiser, including any base lookup
 * (`base.extend(...)`, `base.shape.x`): a thunk that returns an
 * already-built constant saves nothing, and returns an equivalent copy of it
 * rather than the constant itself. So an alias (`const b = a`) stays a plain
 * alias of the stand-in, never `lazySchema(() => a)`.
 */

let declared = 0;
let materialised = 0;

export type LazySchemaStats = {
  /** Stand-ins created: one per `lazySchema` call. */
  readonly declared: number;
  /** Stand-ins that have been read, and so built. */
  readonly materialised: number;
};

export function lazySchemaStats(): LazySchemaStats {
  return { declared, materialised };
}

type Pending = {
  readonly build: () => object;
  readonly standIn: object;
  state: "pending" | "building" | "built";
};

function notAZodSchema(): Error {
  return new Error("lazySchema: the thunk did not return a zod 4 schema");
}

function zodInternals(schema: object): object {
  const internals: unknown = Reflect.get(schema, "_zod");
  if (typeof internals !== "object" || internals === null) {
    throw notAZodSchema();
  }
  return internals;
}

function construct(standIn: object, built: object): void {
  const internals = zodInternals(built);
  const def: unknown = Reflect.get(internals, "def");
  const constr: unknown = Reflect.get(internals, "constr");
  const init: unknown =
    typeof constr === "function" ? Reflect.get(constr, "init") : undefined;
  if (typeof def !== "object" || def === null || typeof init !== "function") {
    throw notAZodSchema();
  }
  // Leave the trigger's chain before construction reads `inst._zod`.
  Object.setPrototypeOf(standIn, Object.getPrototypeOf(built));
  Reflect.apply(init, undefined, [standIn, def]);
  const ownInternals = zodInternals(standIn);
  const parent: unknown = Reflect.get(internals, "parent");
  if (parent !== undefined) {
    Reflect.set(ownInternals, "parent", parent);
  }
  let deferred: unknown = Reflect.get(ownInternals, "deferred");
  if (deferred === undefined) {
    deferred = [];
    Reflect.set(ownInternals, "deferred", deferred);
  }
  if (Array.isArray(deferred)) {
    for (const hook of deferred) {
      if (typeof hook === "function") {
        Reflect.apply(hook, undefined, []);
      }
    }
  }
}

function materialise(pending: Pending): void {
  if (pending.state === "built") {
    return;
  }
  if (pending.state === "building") {
    throw new Error(
      "lazySchema: a schema was read while its own thunk was building it; a self-referential schema needs z.lazy or a getter",
    );
  }
  pending.state = "building";
  try {
    construct(pending.standIn, pending.build());
  } catch (error) {
    pending.state = "pending";
    throw error;
  }
  pending.state = "built";
  materialised += 1;
}

const trigger: ProxyHandler<Pending> = {
  get(pending, key) {
    materialise(pending);
    return Reflect.get(pending.standIn, key);
  },
  has(pending, key) {
    materialise(pending);
    return Reflect.has(pending.standIn, key);
  },
  set(pending, key, value) {
    materialise(pending);
    return Reflect.set(pending.standIn, key, value);
  },
};

export function lazySchema<Schema extends object>(build: () => Schema): Schema {
  const standIn: object = {};
  const pending: Pending = { build, standIn, state: "pending" };
  Object.setPrototypeOf(standIn, new Proxy(pending, trigger));
  declared += 1;
  // The stand-in becomes an instance of `Schema` on its first read; until
  // then every read reaches the trigger, which makes it one first.
  return standIn as Schema;
}
