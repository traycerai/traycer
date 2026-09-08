// Build identities that are deliberately NOT release versions.
//
// Three shapes reach version comparisons in this tree and none of them is a
// release: the unreleased-build fallback, a staging build's runtime stamp, and
// the CLI's synthetic local-install version. They exist because a build that
// was never published still has to identify itself.
//
// This module answers ONE question — "is this string a recognized non-release
// build identity?" — and it is deliberately a recognizer over an enumerated
// set rather than a "not valid SemVer" test. The difference is the whole
// point: `"banana"` is also not valid SemVer, and a policy that waives every
// unparseable string waives typos, truncation and corruption along with the
// dev builds it meant to help.

/**
 * The version an unreleased build reports when the release pipeline injected
 * none — tsx, vitest, a local SEA built without `TRAYCER_CLI_VERSION`.
 *
 * Lives HERE rather than in the CLI so the two policies that must agree about
 * it can import the same string: `evaluateHostClientFloor`, which exempts it
 * BY NAME from the manifest's client floor, and the compatibility fence, which
 * must not refuse a dev build as "below floor". `LOCAL_CLI_VERSION` in
 * `clients/traycer-cli/src/cli-version.ts` is this constant.
 *
 * Note that it IS valid SemVer and sorts below every real release — so unlike
 * the two shapes below it reaches a comparison and loses, rather than being
 * incomparable. That is exactly why it needs naming: a fence that only handled
 * "incomparable" identities would refuse this one and never notice.
 */
export const LOCAL_BUILD_VERSION = "0.0.0-local";

/**
 * What a Desktop run FROM THE SOURCE TREE reports as its version.
 *
 * `clients/desktop/package.json` is committed at `0.0.0` and the release
 * pipeline stamps the real version at package time, so `app.getVersion()`
 * under `make dev-desktop` / `bun run dev` is this bare placeholder - not the
 * `-local` sentinel the bundled CLI and the GUI stamp on themselves. It is
 * valid SemVer and sorts below every floor, so a fence that recognised only
 * {@link LOCAL_BUILD_VERSION} refused every source Desktop as
 * `desktop-below-floor` the moment it had to create an activation attempt
 * (Codex, traycerai/traycer#1773 round 8). Recognised here, beside the other
 * two, so the fence reads it through `nonReleaseIdentityKind` rather than
 * special-casing the string.
 *
 * Scope: this names a DESKTOP identity. The CLI's client floor
 * (`registry/client-floor.ts`) compares against `LOCAL_CLI_VERSION` by name
 * and never sees this constant; a CLI reporting bare `0.0.0` would be
 * compared as SemVer and land below the floor. That is deliberate - no CLI
 * path yields bare `0.0.0` (`resolveCliVersion` injects a version or falls
 * back to the `-local` sentinel), so recognising it there would license a
 * path that does not exist.
 */
export const SOURCE_TREE_VERSION = "0.0.0";

/**
 * A staging host's runtime stamp: `staging.<epoch-millis>.<sha>`, e.g.
 * `staging.1783550586518.bb8c937d9`. Not SemVer at all, so every comparison
 * against it is `{comparable: false}`.
 */
const STAGING_IDENTITY_PATTERN = /^staging\.\d+\.[0-9a-f]+$/;

/**
 * The CLI's synthetic version for a local-FILE install, minted by
 * `deriveLocalVersion` as `local-${basename}-${isoStampWithColonsReplaced}` —
 * e.g. `local-traycer-host.tar.gz-2026-09-07T19-30-00-000Z`.
 *
 * Anchored on the trailing stamp rather than on the `local-` prefix alone, and
 * that tightness is the point: `local-dev`, `local-`, `local-anything` are not
 * shapes any generator in this tree produces, so admitting them would widen
 * the waiver past the builds it exists for. The basename half stays `.+`
 * because it is a filename and can contain almost anything.
 */
const LOCAL_INSTALL_IDENTITY_PATTERN =
  /^local-.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Which non-release shape a string is, or `null` for anything else —
 * including malformed and truncated strings, which are NOT waived.
 */
export type NonReleaseIdentityKind =
  /** The unreleased-build fallback. Valid SemVer, sorts below every release. */
  | "local-build"
  /** A staging build's runtime stamp. Not SemVer. */
  | "staging-build"
  /** A locally-built install's synthetic version. Not SemVer. */
  | "local-install";

export function nonReleaseIdentityKind(
  value: string,
): NonReleaseIdentityKind | null {
  if (value === LOCAL_BUILD_VERSION || value === SOURCE_TREE_VERSION) {
    return "local-build";
  }
  if (STAGING_IDENTITY_PATTERN.test(value)) return "staging-build";
  if (LOCAL_INSTALL_IDENTITY_PATTERN.test(value)) return "local-install";
  return null;
}
