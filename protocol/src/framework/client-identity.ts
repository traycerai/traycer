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
 */
export const clientHandshakeIdentitySchema = z.object({
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

/** Which release line the remedy lives on. */
export type ClientUpgradeChannel = "stable" | "rc";

/**
 * The structured half of an epoch rejection, carried additively on
 * {@link FatalErrorDetails}.
 *
 * `minimumKnownClientAppVersion` is the earliest official build known to carry
 * the required epoch on the relevant channel. It EXPLAINS the remedy; it is
 * never compared for admission, so a backport that declares epoch 2 is
 * accepted even when its SemVer sorts below this string.
 */
export type ClientCompatibilityRequirement = {
  readonly minimumCompatibilityEpoch: number;
  readonly observedCompatibilityEpoch: number | null;
  readonly failure: ClientCompatibilityFailure;
  readonly observedClientKind: string | null;
  readonly observedClientAppVersion: string | null;
  readonly observedClientAppVersionStatus: "valid" | "missing" | "invalid";
  readonly minimumKnownClientAppVersion: string | null;
  readonly upgradeChannel: ClientUpgradeChannel | null;
};

export const clientCompatibilityRequirementSchema = z.object({
  minimumCompatibilityEpoch: z.number().int().positive(),
  observedCompatibilityEpoch: z.number().nullable(),
  failure: z.enum(["missing-epoch", "invalid-epoch", "below-minimum"]),
  observedClientKind: z.string().nullable(),
  observedClientAppVersion: z.string().nullable(),
  observedClientAppVersionStatus: z.enum(["valid", "missing", "invalid"]),
  minimumKnownClientAppVersion: z.string().nullable(),
  upgradeChannel: z.enum(["stable", "rc"]).nullable(),
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
