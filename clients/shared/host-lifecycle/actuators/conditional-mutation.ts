/**
 * Shared last-safe-point gate for lifecycle mutations.
 *
 * A planner decision is only evidence from one instant.  The caller must run
 * the supplied probe again while it owns the client-side serialization lock;
 * no mutator receives control until that comparison succeeds.
 */
export type SerializedSection = <T>(work: () => Promise<T>) => Promise<T>;

export type PreconditionSnapshot<World> = {
  /** Retained for diagnostics and for platform-specific final checks. */
  readonly expected: World;
  /** Immutable canonical form captured at the planner/actuator boundary. */
  readonly fingerprint: string;
};

export type MutationResult =
  | { readonly kind: "applied" }
  | {
      readonly kind: "stale-precondition";
      readonly operation: string;
      readonly expectedFingerprint: string;
      readonly actualFingerprint: string;
    }
  | {
      /**
       * The world did not change under us, but this operation is not
       * permitted against this target in it. Distinct from
       * `stale-precondition`: re-probing will not make it true, so the
       * planner must re-decide rather than retry.
       */
      readonly kind: "refused";
      readonly operation: string;
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly operation: string;
      readonly cause: string;
    };

/**
 * The outcome of binding an operation to a concrete target in the *re-probed*
 * world. `target` is what the mutator acts on — it is selected here, from
 * observed state, never supplied by the caller alongside an unrelated
 * operation name.
 */
export type MutationAuthorization<Target> =
  | { readonly kind: "authorized"; readonly target: Target }
  | { readonly kind: "refused"; readonly reason: string };

export function capturePreconditions<World>(
  expected: World,
): PreconditionSnapshot<World> {
  return { expected, fingerprint: canonicalFingerprint(expected) };
}

/**
 * Re-probes in the serialized section and invokes `mutate` only if (1) every
 * captured observed field still has the same value and (2) `authorize` binds
 * the operation to a target in that re-probed world.
 *
 * Both halves are load-bearing and they answer different questions. The
 * fingerprint answers "did anything move under us"; it is content-blind, so it
 * cannot tell an eviction of the competing CLI registration from a bootout of
 * the healthy agent — the world is identical in both. `authorize` answers "is
 * this operation legal here, and against what". It *returns* the target, so a
 * mutator cannot be handed one operation's authority and another's object.
 */
export async function runConditionalMutation<World, Target>(input: {
  readonly serialized: SerializedSection;
  readonly expected: PreconditionSnapshot<World>;
  readonly probe: () => Promise<World>;
  readonly operation: string;
  readonly authorize: (world: World) => MutationAuthorization<Target>;
  readonly mutate: (target: Target) => Promise<void>;
}): Promise<MutationResult> {
  return input.serialized(async () => {
    const actual = await input.probe();
    const actualFingerprint = canonicalFingerprint(actual);
    if (actualFingerprint !== input.expected.fingerprint) {
      return {
        kind: "stale-precondition",
        operation: input.operation,
        expectedFingerprint: input.expected.fingerprint,
        actualFingerprint,
      };
    }

    const authorization = input.authorize(actual);
    if (authorization.kind === "refused") {
      return {
        kind: "refused",
        operation: input.operation,
        reason: authorization.reason,
      };
    }

    try {
      await input.mutate(authorization.target);
      return { kind: "applied" };
    } catch (error) {
      return {
        kind: "failed",
        operation: input.operation,
        cause: errorMessage(error),
      };
    }
  });
}

/**
 * Stable over object-key order and preserves Maps/Sets, which matter for a
 * parsed launchctl print. JSON.stringify alone silently turns a Map into
 * `{}`, allowing a changed supervisor observation to evade revalidation.
 */
export function canonicalFingerprint(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${String(value)}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `bigint:${String(value)}`;
  if (typeof value === "symbol" || typeof value === "function") {
    throw new Error(
      "Lifecycle preconditions must be data, not executable values",
    );
  }
  if (Array.isArray(value)) {
    return `array:[${value.map((entry) => canonicalFingerprint(entry)).join(",")} ]`;
  }
  if (value instanceof Map) {
    const entries = Array.from(
      value.entries(),
      ([key, entry]) =>
        `${canonicalFingerprint(key)}=>${canonicalFingerprint(entry)}`,
    ).sort();
    return `map:{${entries.join(",")}}`;
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values(), (entry) =>
      canonicalFingerprint(entry),
    ).sort();
    return `set:{${entries.join(",")}}`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalFingerprint(entry)}`,
      );
    return `object:{${entries.join(",")}}`;
  }
  throw new Error("Lifecycle preconditions contain an unsupported value");
}

function isRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
