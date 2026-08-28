import { z } from "zod";

/**
 * WHO IS CONNECTING, sent once per logical connection on every open frame.
 *
 * Three different questions are answered by three different signals, and none
 * of them may impersonate another:
 *
 * | signal                | question                                              | authority              |
 * | --------------------- | ----------------------------------------------------- | ---------------------- |
 * | `compatibilityEpoch`  | does this client satisfy the host generation's         | host admission policy  |
 * |                       | architectural assumptions?                            |                        |
 * | `appVersion`          | which packaged build reported this, and what should    | diagnostics + UX only  |
 * |                       | the user install?                                     |                        |
 * | RPC/stream manifests  | can these exact method schemas communicate or bridge?  | existing negotiation   |
 *
 * The host must not infer client age from the presence of a product method, it
 * must not reject an epoch-compatible client because its diagnostic version is
 * missing or malformed, and passing the epoch gate must not bypass manifest
 * negotiation. That separation is the whole point of this module: the previous
 * shape of this problem was a host reading `epic.listChatRecords` out of a
 * manifest as an age marker, which permanently welded a product RPC to a
 * compatibility decision.
 *
 * Identity is a compatibility ASSERTION, not a credential. A custom client can
 * lie about every field here, so authentication and authorization must never
 * depend on any of them.
 */

/**
 * `clientCompatibilityEpoch` is a positive integer with CUMULATIVE meaning:
 *
 * ```text
 * epoch N promises every architectural guarantee from epochs 1..N
 * ```
 *
 * so a host accepts every valid epoch at or above its own minimum, and a
 * client that declares a later epoch than the host has heard of is accepted
 * rather than treated as unknown.
 *
 * | epoch | client generation                | guarantee                                                     |
 * | ----- | -------------------------------- | ------------------------------------------------------------- |
 * | `1`   | every pre-field client           | legacy; may depend on the `epic.chats` Yjs projection          |
 * | `2`   | first host-1.2-compatible builds | does not depend on that projection; works off store-backed     |
 * |       |                                  | chat records                                                   |
 *
 * If a future architectural change cannot preserve all earlier guarantees, a
 * scalar cumulative epoch has stopped being expressive enough and that change
 * needs explicit capabilities or supported-generation sets - it must NOT
 * pretend `3 >= 2` is safe.
 */
export const LEGACY_CLIENT_COMPATIBILITY_EPOCH = 1;

/**
 * The epoch every CURRENT first-party build declares - the single reviewed
 * source, deliberately not derived from SemVer and not restated at each
 * sender.
 *
 * Incrementing this is an ARCHITECTURAL compatibility decision, not a
 * consequence of a version bump: a build that adds or removes a product RPC
 * keeps this value, and only a change to what the client structurally
 * guarantees the host may raise it.
 */
export const CURRENT_CLIENT_COMPATIBILITY_EPOCH = 2;

/**
 * The identity as it appears ON THE WIRE. Every member is optional, and both
 * halves of that are load-bearing:
 *
 * - An old client omits the whole object, so it must reach the host's
 *   deliberate legacy-epoch verdict rather than fail generic frame parsing
 *   with an unactionable "malformed frame".
 * - A new client talking to a released old host stays compatible because the
 *   existing non-strict Zod objects STRIP the unknown top-level field.
 */
export type ClientHandshakeIdentity = {
  /** Open string, for forward-compatible diagnostics. Never gates admission. */
  readonly kind?: string;
  /** The only field host admission policy evaluates. */
  readonly compatibilityEpoch?: number;
  /** Diagnostic string. Strict SemVer is validated outside wire parsing. */
  readonly appVersion?: string;
};

/**
 * Canonical wire schema. Deliberately NOT `.strict()` and deliberately
 * permissive about VALUES:
 *
 * - `compatibilityEpoch` is `z.number()`, not `z.number().int().positive()`.
 *   Positive-safe-integer validation belongs to the policy evaluator so a
 *   malformed epoch takes the same actionable "update your client" path as a
 *   too-old one, instead of dying as a frame parse error the user cannot act
 *   on.
 * - `kind`/`appVersion` are unbounded `z.string()`. Bounding them HERE would
 *   turn an over-long value into that same unactionable parse failure; the
 *   normalizer bounds them for diagnostics instead, which is the only place
 *   the untrusted text is ever read.
 *
 * ANNOTATED `z.ZodType<ClientHandshakeIdentity>` so the schema and the
 * hand-written type cannot drift apart silently, matching how `mux.ts`
 * annotates its own wire payload schemas. Unlike
 * `clientCompatibilityRequirementSchema`, this one has no typed parse
 * boundary downstream to catch drift for it - the requirement is re-parsed
 * into a typed return by `parseClientCompatibility`, this is not.
 *
 * WHAT THE ANNOTATION ACTUALLY CATCHES, measured rather than assumed
 * (probe against this repo's zod + tsc):
 *
 *   caught:     the type gains a REQUIRED member the schema does not produce
 *   caught:     a member's value type diverges (`z.string()` vs `number`)
 *   NOT caught: the type gains an OPTIONAL member the schema does not produce
 *   NOT caught: the schema gains a member the type does not declare
 *
 * Every member here is optional today, so the most likely future drift is one
 * of the two it does not catch. It is kept because it costs nothing and closes
 * the other two - not because it makes the pair safe. A new member still has
 * to be added in both places by hand.
 */
export const clientHandshakeIdentitySchema: z.ZodType<ClientHandshakeIdentity> =
  z.object({
    kind: z.string().optional(),
    compatibilityEpoch: z.number().optional(),
    appVersion: z.string().optional(),
  });

/** The client kinds first-party builds declare. */
export type FirstPartyClientKind = "desktop" | "cli";

/**
 * What a FIRST-PARTY producer must hold, which is strictly stricter than the
 * permissive wire shape above.
 *
 * Transport constructors take this as an explicit REQUIRED dependency, so a
 * current build cannot ship a connection that forgot to identify itself. Only
 * the nullable `appVersion` may be absent from what actually goes on the wire.
 */
export type FirstPartyClientIdentity = {
  readonly kind: FirstPartyClientKind;
  readonly compatibilityEpoch: number;
  readonly appVersion: string | null;
};

/**
 * Projects a first-party identity onto the wire shape, dropping only a null
 * `appVersion`. Single-sourced so the three planes cannot drift in how they
 * serialize the same process constant.
 */
export function toClientHandshakeIdentity(
  identity: FirstPartyClientIdentity,
): ClientHandshakeIdentity {
  if (identity.appVersion === null) {
    return {
      kind: identity.kind,
      compatibilityEpoch: identity.compatibilityEpoch,
    };
  }
  return {
    kind: identity.kind,
    compatibilityEpoch: identity.compatibilityEpoch,
    appVersion: identity.appVersion,
  };
}

/** Why an epoch gate rejected a connection. */
export type ClientCompatibilityFailure =
  | "missing-epoch"
  | "invalid-epoch"
  | "below-minimum";

/**
 * The release lines a host build can report as its own, for the client's
 * RECOVERY ROUTING - never for admission.
 *
 * Deliberately NOT a closed union on the wire (see
 * {@link ClientCompatibilityRequirement.hostReleaseChannel}): a host bakes this
 * string from its own build config, which already carries `dev` for a source
 * build, and a future line must not make a shipped client fail to parse a
 * fatal. These are the values a client is expected to RECOGNIZE; everything
 * else is legal and simply routes conservatively.
 */
export const KNOWN_HOST_RELEASE_CHANNELS = ["stable", "rc", "dev"] as const;
export type KnownHostReleaseChannel =
  (typeof KNOWN_HOST_RELEASE_CHANNELS)[number];

/**
 * Whether a rejecting host's release channel authorizes a client to look for
 * its remedy on the RC line.
 *
 * The one question this answers, and it is deliberately narrow: only the exact
 * string `rc` does. An absent channel (a host that predates the field), `dev`,
 * `stable`, and any value this build has never heard of all return `false`, so
 * a client never offers an RC opt-in on the strength of a channel it could not
 * interpret. Written as a positive match rather than "not stable" for exactly
 * that reason - the negative form turns every future channel into an RC route.
 */
export function hostReleaseChannelAllowsRcRecovery(
  hostReleaseChannel: string | null | undefined,
): boolean {
  return hostReleaseChannel === "rc";
}

/**
 * The structured half of an epoch rejection, carried additively on
 * {@link FatalErrorDetails}.
 *
 * WHAT IS AND IS NOT HERE. Admission is epoch-only, and so is the remedy: the
 * host states the generation it requires and which release line IT is on, and
 * the client resolves an obtainable build through the update mechanism it
 * already owns. A product version, a per-family catalog, or a download URL
 * never appears on this wire - the host cannot know which build of which client
 * family a given peer can actually install, and a host that guesses names a
 * remedy some rejected population cannot follow.
 */
export type ClientCompatibilityRequirement = {
  readonly minimumCompatibilityEpoch: number;
  readonly observedCompatibilityEpoch: number | null;
  readonly failure: ClientCompatibilityFailure;
  readonly observedClientKind: string | null;
  readonly observedClientAppVersion: string | null;
  readonly observedClientAppVersionStatus: "valid" | "missing" | "invalid";
  /**
   * @deprecated Never populated. Hosts stopped naming a remedy build when
   * admission became epoch-only: the host has no way to know which build of
   * desktop, CLI, or a future client family a given peer can obtain, and one
   * string cannot be the answer for all of them.
   *
   * KEPT ON THE WIRE, nullable, because shipped clients parse this object with
   * their own copy of the schema and a REMOVED member is a parse failure for
   * them - which would turn an actionable "update your app" into an
   * unactionable malformed fatal for precisely the population this mechanism
   * exists to reach. They already handle `null`.
   */
  readonly minimumKnownClientAppVersion: string | null;
  /**
   * @deprecated Never populated, kept nullable for the same wire-compatibility
   * reason as {@link minimumKnownClientAppVersion}. A client that wants to know
   * which line the HOST is on reads {@link hostReleaseChannel} instead - which
   * is a fact about the host, not a claim about where some other component's
   * remedy was published.
   */
  readonly upgradeChannel: "stable" | "rc" | null;
  /**
   * The release line of the host that produced this rejection - `stable`, `rc`,
   * or `dev` today (see {@link KNOWN_HOST_RELEASE_CHANNELS}).
   *
   * OPTIONAL, not nullable, and the two are different guarantees here. A host
   * that predates this field omits the key entirely, so a newer client parsing
   * an older host's fatal must not require it; making it required would break
   * exactly the direction wire compatibility is supposed to protect.
   *
   * AN OPEN STRING, not an enum, for the mirror-image reason: a host bakes this
   * from its own build config, and a future line must not make a shipped
   * client's schema reject the whole requirement over a value it has never
   * heard of. Consumers route through
   * {@link hostReleaseChannelAllowsRcRecovery}, which recognizes `rc` and
   * treats everything else - including `dev` and anything unknown - as no RC
   * routing.
   *
   * IT NEVER PARTICIPATES IN ADMISSION. The host already decided that from the
   * epoch alone; this exists so a client can tell whether looking on the RC
   * line could possibly find a build that clears the floor.
   */
  readonly hostReleaseChannel?: string;
};

export const clientCompatibilityRequirementSchema = z.object({
  minimumCompatibilityEpoch: z.number().int().positive(),
  observedCompatibilityEpoch: z.number().nullable(),
  failure: z.enum(["missing-epoch", "invalid-epoch", "below-minimum"]),
  observedClientKind: z.string().nullable(),
  observedClientAppVersion: z.string().nullable(),
  observedClientAppVersionStatus: z.enum(["valid", "missing", "invalid"]),
  minimumKnownClientAppVersion: z.string().nullable(),
  // Inline literals, deliberately not a shared exported constant: the member
  // is deprecated and never populated, so these values exist only to keep the
  // parse shape of an already-shipped wire member. Nothing else may grow a
  // dependency on them.
  upgradeChannel: z.enum(["stable", "rc"]).nullable(),
  // `.optional()` and a bare `z.string()`, both load-bearing - see the type's
  // member doc. Absent-tolerant so an older host's fatal still parses here, and
  // unconstrained so a newer host's channel does not fail the whole object in a
  // client that has already shipped.
  hostReleaseChannel: z.string().optional(),
});

/**
 * True for a positive safe integer - the only epoch shape admission policy may
 * act on.
 *
 * Exported so the host evaluator, the packaging validator, and any test all
 * ask the same question. An epoch that fails this is INVALID, never "very
 * new": treating an unparseable claim as future-dated is exactly how a gate
 * fails open.
 */
export function isValidCompatibilityEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * THE canonical strict-SemVer grammar for a diagnostic client version, as a
 * PATTERN STRING so every consumer builds the same `RegExp` from one source.
 *
 * This is semver.org's own published regex (the "suggested regular expression"
 * from the 2.0.0 spec) verbatim, not a hand-rolled approximation. That matters
 * because the value it accepts crosses a MODULE-SYSTEM boundary: the host
 * evaluates it in TypeScript at connection time, and the release stamper
 * evaluates it in CommonJS at packaging time. Two gates that disagree are
 * worse than one - a version the stamper accepts and the host refuses is baked
 * into every platform artifact of a release and fails host startup on users'
 * machines after publication, which is exactly the failure this pattern being
 * shared prevents.
 *
 * Non-obvious properties that the looser alternatives get wrong, and that the
 * parity corpus in `scripts/__tests__/client-identity-policy-parity.test.mjs`
 * pins:
 *
 *  - It is ANCHORED, so `v1.2.0` and `" 1.2.0 "` are rejected. `semver.valid`
 *    accepts both and returns the CLEANED form, so a validator built on it
 *    must compare `semver.valid(v) === v` rather than `!== null`.
 *  - It forbids LEADING ZEROS in the numeric identifiers (`01.2.3`,
 *    `1.2.3-01`), which a naive `\d+` grammar accepts.
 */
export const STRICT_SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$";

const STRICT_SEMVER = new RegExp(STRICT_SEMVER_PATTERN, "u");

/**
 * Longest client-supplied `appVersion` any consumer will read, let alone
 * repeat.
 *
 * NOT a semantic threshold and not a guess about real build strings: SemVer
 * places no bound on prerelease identifiers, so `1.0.0-` followed by megabytes
 * of `[0-9A-Za-z-]` is a *valid* version. `ws` accepts a 100 MiB frame by
 * default, and this value lands in a host warn line, in the fatal payload, and
 * in GUI copy - and on the remote plane an oversized fatal is re-classed BULK
 * and may never be delivered at all. 64 is far above every real build string
 * this project produces (`1.2.0-rc.2`, `production.1755900000000.a1b2c3d`) and
 * far below anything that could flood a log or a frame.
 *
 * Exceeding it makes the version diagnostically INVALID. It never affects
 * admission - the epoch alone decides that, and a client with a compliant
 * epoch and a 200 KB version string still connects.
 */
export const MAX_DIAGNOSTIC_APP_VERSION_LENGTH = 64;

/**
 * True for a version string this project is willing to compare, bake, or
 * repeat back to a user.
 *
 * Length is checked FIRST so an over-long candidate never reaches the regex -
 * the published SemVer grammar is backtracking-capable on the prerelease
 * alternation, and feeding it an unbounded peer-supplied string is the one way
 * this cheap check becomes expensive.
 */
export function isStrictSemVer(value: string): boolean {
  return (
    value.length <= MAX_DIAGNOSTIC_APP_VERSION_LENGTH &&
    STRICT_SEMVER.test(value)
  );
}
