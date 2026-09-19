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
 * What a PENDING stand-in does not do: it has no own keys, and an operation
 * that reads only own keys never reaches the trigger. `Object.keys`,
 * `Object.getOwnPropertyDescriptor(s)`, `hasOwnProperty`, a spread or an
 * `Object.assign` source see an empty object; `structuredClone`,
 * `v8.serialize` and `postMessage` SUCCEED with `{}` where an eager schema
 * throws `DataCloneError`; `Object.getPrototypeOf` returns the trigger. Only
 * a stand-in that is itself a Proxy could trap those, and that is the design
 * rejected above. No code reads a schema that way;
 * `lazy-schema-standin-ops-scan.test.ts` pins the scan that says so.
 * `JSON.stringify` is not among them: it reads `toJSON` through the
 * prototype, which builds the schema first.
 *
 * `build` must return the schema as zod's constructor left it. State a zod
 * factory or method attaches AFTER `new` would stay on the discarded instance:
 * `.describe()`, `.meta()` and `.register()` as the outermost call, the check
 * `z.instanceof` installs, and a cycle closed through a const declared inside
 * the thunk (`z.json()`, or a getter or `z.lazy` naming that const; naming
 * the module-scope stand-in itself is fine). The first read REFUSES the
 * global-registry case, and any `_zod` or `_zod.bag` key the stand-in did not
 * get (that is `z.instanceof`), with an error naming the rule; the rest has
 * no runtime trace, and `lazy-schema-thunk-rules-scan.test.ts` rejects all of
 * them in source. Put the metadata on an inner schema, or declare that
 * schema eagerly.
 *
 * `build` must have no effect beyond the value it returns. It runs on the
 * first read, not at import, so a registration or counter inside it happens
 * late or never; register at module scope and build inside the thunk.
 *
 * A read that fails leaves no half-built schema. A throw from `build`, or the
 * global-registry refusal, happens before the stand-in is touched: it stays
 * pending, and the next read runs `build` again. A throw once zod is
 * constructing the stand-in in place (the lost-key refusal, or a zod change,
 * since `build` just succeeded on the same `def`) cannot be retried, because
 * zod defines some keys non-configurable. The stand-in then gets its trigger
 * back and rethrows that same error on every later read; only those keys
 * (`_def`, a literal's `value`) keep what the failed construction gave them.
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

type PendingState =
  | { readonly kind: "pending" }
  | { readonly kind: "building" }
  | { readonly kind: "built" }
  | { readonly kind: "failed"; readonly error: unknown };

type Pending = {
  readonly build: () => object;
  readonly standIn: object;
  state: PendingState;
};

const PENDING: PendingState = { kind: "pending" };
const BUILDING: PendingState = { kind: "building" };
const BUILT: PendingState = { kind: "built" };

function notAZodSchema(): Error {
  return new Error("lazySchema: the thunk did not return a zod 4 schema");
}

function lostPostConstructionState(what: string): Error {
  return new Error(
    `lazySchema: the thunk's schema carries ${what}, which zod attaches after construction and the stand-in cannot carry; put it on an inner schema or declare this schema eagerly`,
  );
}

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function zodInternals(schema: object): object {
  const internals: unknown = Reflect.get(schema, "_zod");
  if (!isObject(internals)) {
    throw notAZodSchema();
  }
  return internals;
}

/**
 * Every zod copy shares one global registry through this global, so the
 * helper reads it without importing zod.
 */
function isInGlobalRegistry(schema: object): boolean {
  const registry: unknown = Reflect.get(globalThis, "__zod_globalRegistry");
  if (!isObject(registry)) {
    return false;
  }
  const has: unknown = Reflect.get(registry, "has");
  return (
    typeof has === "function" && Reflect.apply(has, registry, [schema]) === true
  );
}

type Construction = {
  /** The discarded instance's `_zod`. */
  readonly internals: object;
  readonly prototype: object | null;
  readonly def: object;
  readonly constr: object;
  /** `constr.init(inst, def)`: zod's construction, run on `inst` in place. */
  readonly initialise: (inst: object) => void;
};

/**
 * Reads what `construct` needs from the instance `build` returned, and
 * refuses it before anything touches the stand-in.
 */
function readConstruction(built: object): Construction {
  const internals = zodInternals(built);
  const def: unknown = Reflect.get(internals, "def");
  const constr: unknown = Reflect.get(internals, "constr");
  const init: unknown =
    typeof constr === "function" ? Reflect.get(constr, "init") : undefined;
  if (
    !isObject(def) ||
    typeof constr !== "function" ||
    typeof init !== "function"
  ) {
    throw notAZodSchema();
  }
  if (isInGlobalRegistry(built)) {
    throw lostPostConstructionState(
      "global-registry metadata (.describe, .meta or .register)",
    );
  }
  return {
    internals,
    prototype: Object.getPrototypeOf(built),
    def,
    constr,
    initialise: (inst) => {
      Reflect.apply(init, undefined, [inst, def]);
    },
  };
}

/**
 * A key the discarded instance's `_zod` or `_zod.bag` has and the stand-in's
 * lacks was attached after construction (`z.instanceof` sets `bag.Class`).
 * Forcing every protocol stand-in finds no such key, so this refuses only
 * state that would otherwise be lost.
 */
function refuseLostInternals(built: object, own: object): void {
  for (const key of Reflect.ownKeys(built)) {
    if (!Reflect.has(own, key)) {
      throw lostPostConstructionState(`_zod.${String(key)}`);
    }
  }
  const builtBag: unknown = Reflect.get(built, "bag");
  const ownBag: unknown = Reflect.get(own, "bag");
  if (!isObject(builtBag) || !isObject(ownBag)) {
    return;
  }
  for (const key of Reflect.ownKeys(builtBag)) {
    if (!Reflect.has(ownBag, key)) {
      throw lostPostConstructionState(
        `_zod.bag.${String(key)} (z.instanceof sets bag.Class)`,
      );
    }
  }
}

function construct(standIn: object, construction: Construction): void {
  const { internals, def, constr } = construction;
  const triggerPrototype: object | null = Object.getPrototypeOf(standIn);
  // Leave the trigger's chain before construction reads `inst._zod`.
  Object.setPrototypeOf(standIn, construction.prototype);
  try {
    // zod's `init` defines `_zod` only on an instance that has none, and then
    // non-configurable. Defining the same value here, configurable, is what
    // lets a failed construction be undone below.
    Object.defineProperty(standIn, "_zod", {
      value: { def, constr, traits: new Set<string>() },
      enumerable: false,
      writable: false,
      configurable: true,
    });
    construction.initialise(standIn);
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
    refuseLostInternals(internals, ownInternals);
    // As `new` leaves it.
    Object.defineProperty(standIn, "_zod", { configurable: false });
  } catch (error) {
    // Put the trigger back so every later read reaches `materialise`, which
    // rethrows `error`. Keys zod defined non-configurable stay.
    for (const key of Reflect.ownKeys(standIn)) {
      Reflect.deleteProperty(standIn, key);
    }
    Object.setPrototypeOf(standIn, triggerPrototype);
    throw error;
  }
}

function materialise(pending: Pending): void {
  const state = pending.state;
  if (state.kind === "built") {
    return;
  }
  if (state.kind === "failed") {
    throw state.error;
  }
  if (state.kind === "building") {
    throw new Error(
      "lazySchema: a schema was read while its own thunk was building it; a self-referential schema needs z.lazy or a getter",
    );
  }
  pending.state = BUILDING;
  let construction: Construction;
  try {
    construction = readConstruction(pending.build());
  } catch (error) {
    pending.state = PENDING;
    throw error;
  }
  try {
    construct(pending.standIn, construction);
  } catch (error) {
    pending.state = { kind: "failed", error };
    throw error;
  }
  pending.state = BUILT;
  materialised += 1;
}

const trigger: ProxyHandler<Pending> = {
  get(pending, key, receiver) {
    materialise(pending);
    return Reflect.get(pending.standIn, key, receiver);
  },
  has(pending, key) {
    materialise(pending);
    return Reflect.has(pending.standIn, key);
  },
  set(pending, key, value, receiver) {
    materialise(pending);
    return Reflect.set(pending.standIn, key, value, receiver);
  },
};

export function lazySchema<Schema extends { readonly _zod: object }>(
  build: () => Schema,
): Schema {
  const standIn: object = {};
  const pending: Pending = { build, standIn, state: PENDING };
  Object.setPrototypeOf(standIn, new Proxy(pending, trigger));
  declared += 1;
  // The stand-in becomes an instance of `Schema` on its first read; until
  // then every read reaches the trigger, which makes it one first.
  return standIn as Schema;
}
