import { z } from "zod";

/**
 * WHO IS CONNECTING, sent once per logical connection on every open frame.
 * A custom client can lie about every field here, so authentication and authorization must never depend on any of them.
 */

/** `clientCompatibilityEpoch` is a positive integer with CUMULATIVE meaning */
export const LEGACY_CLIENT_COMPATIBILITY_EPOCH = 1;

/**
 * The epoch every CURRENT first-party build declares - the single reviewed source, deliberately not derived from SemVer and not restated at each sender.
 */
export const CURRENT_CLIENT_COMPATIBILITY_EPOCH = 2;

/** The identity as it appears ON THE WIRE. */
export type ClientHandshakeIdentity = {
  /** Open string, for forward-compatible diagnostics. Never gates admission. */
  readonly kind?: string;
  /** The only field host admission policy evaluates. */
  readonly compatibilityEpoch?: number;
  /** Diagnostic string. Strict SemVer is validated outside wire parsing. */
  readonly appVersion?: string;
};

/**
 * Canonical wire schema.
 * ANNOTATED `z.ZodType<ClientHandshakeIdentity>` so the schema and the hand-written type cannot drift apart silently, matching how `mux.ts` annotates its own wire payload schemas.
 */
export const clientHandshakeIdentitySchema: z.ZodType<ClientHandshakeIdentity> =
  z.object({
    kind: z.string().optional(),
    compatibilityEpoch: z.number().optional(),
    appVersion: z.string().optional(),
  });

/** The client kinds first-party builds declare. */
export type FirstPartyClientKind = "desktop" | "cli" | "mobile";

/**
 * What a FIRST-PARTY producer must hold, which is strictly stricter than the permissive wire shape above.
 * Only the nullable `appVersion` may be absent from what actually goes on the wire.
 */
export type FirstPartyClientIdentity = {
  readonly kind: FirstPartyClientKind;
  readonly compatibilityEpoch: number;
  readonly appVersion: string | null;
};

/**
 * Projects a first-party identity onto the wire shape, dropping only a null `appVersion`.
 * Single-sourced so the three planes cannot drift in how they serialize the same process constant.
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
 * The release lines a host build can report as its own, for the client's RECOVERY ROUTING - never for admission.
 */
export const KNOWN_HOST_RELEASE_CHANNELS = ["stable", "rc", "dev"] as const;
export type KnownHostReleaseChannel =
  (typeof KNOWN_HOST_RELEASE_CHANNELS)[number];

/**
 * Whether a rejecting host's release channel authorizes a client to look for its remedy on the RC line.
 * An absent channel (a host that predates the field), `dev`, `stable`, and any value this build has never heard of all return `false`, so a client never offers an RC opt-in on the strength of a channel it could not.
 */
export function hostReleaseChannelAllowsRcRecovery(
  hostReleaseChannel: string | null | undefined,
): boolean {
  return hostReleaseChannel === "rc";
}

/** The structured half of an epoch rejection, carried additively on {@link FatalErrorDetails}. */
export type ClientCompatibilityRequirement = {
  readonly minimumCompatibilityEpoch: number;
  readonly observedCompatibilityEpoch: number | null;
  readonly failure: ClientCompatibilityFailure;
  readonly observedClientKind: string | null;
  readonly observedClientAppVersion: string | null;
  readonly observedClientAppVersionStatus: "valid" | "missing" | "invalid";
  /**
   * @deprecated Never populated.
   * Hosts stopped naming a remedy build when admission became epoch-only: the host has no way to know which build of desktop, CLI, or a future client family a given peer can obtain, and one string cannot be the answer for.
   */
  readonly minimumKnownClientAppVersion: string | null;
  /**
   * @deprecated Never populated, kept nullable for the same wire-compatibility reason as {@link minimumKnownClientAppVersion}.
   */
  readonly upgradeChannel: "stable" | "rc" | null;
  /**
   * The release line of the host that produced this rejection - `stable`, `rc`, or `dev` today (see {@link KNOWN_HOST_RELEASE_CHANNELS}).
   * OPTIONAL, not nullable, and the two are different guarantees here.
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
  // Inline literals, deliberately not a shared exported constant: the member is deprecated and never populated, so these values exist only to keep the parse shape of an already-shipped wire member.
  upgradeChannel: z.enum(["stable", "rc"]).nullable(),
  // `.optional()` and a bare `z.string()`, both load-bearing - see the type's member doc.
  hostReleaseChannel: z.string().optional(),
});

/**
 * True for a positive safe integer - the only epoch shape admission policy may act on.
 * An epoch that fails this is INVALID, never "very new": treating an unparseable claim as future-dated is exactly how a gate fails open.
 */
export function isValidCompatibilityEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * THE canonical strict-SemVer grammar for a diagnostic client version, as a PATTERN STRING so every consumer builds the same `RegExp` from one source.
 */
export const STRICT_SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$";

const STRICT_SEMVER = new RegExp(STRICT_SEMVER_PATTERN, "u");

/**
 * Longest client-supplied `appVersion` any consumer will read, let alone repeat.
 * It never affects admission - the epoch alone decides that, and a client with a compliant epoch and a 200 KB version string still connects.
 */
export const MAX_DIAGNOSTIC_APP_VERSION_LENGTH = 64;

/** True for a version string this project is willing to compare, bake, or repeat back to a user. */
export function isStrictSemVer(value: string): boolean {
  return (
    value.length <= MAX_DIAGNOSTIC_APP_VERSION_LENGTH &&
    STRICT_SEMVER.test(value)
  );
}
