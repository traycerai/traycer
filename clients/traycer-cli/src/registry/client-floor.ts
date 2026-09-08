import {
  compareHostVersions,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { LOCAL_CLI_VERSION } from "../cli-version";

/**
 * The host manifest's client floor, ENFORCED.
 *
 * `requiredCliVersion` has been on every manifest entry since the registry
 * landed, and until now it was explicitly parse-only: read so the manifest
 * validated, acted on nowhere. That is fine while every host ships bundled
 * provider bytes and an old client merely misses a field. It stops being fine
 * the moment a host is published that an older client cannot correctly
 * EXPLAIN: the protocol handshake succeeds, the bridge projects the newer
 * state down, and the affected rows quietly disappear from a UI that has no
 * vocabulary for why. A field nobody reads is not a floor.
 *
 * Enforced as a REFUSAL, not as version resolution. When the selected version
 * declares a floor this CLI does not meet, the install stops with a named
 * error and the remedy in the message. Picking a different, older host
 * instead - "resolve down to the newest version I can run" - is the compat
 * RANGE resolution that was deliberately deferred, and quietly installing
 * something other than what the user asked for is the wrong default for the
 * one decision that determines what their machine runs.
 *
 * Judged against the version this CLI advertises, which is injected at build
 * time. An UNRELEASED build (tsx, vitest, a local SEA) reports
 * `0.0.0-local` - genuinely below every floor by SemVer, and blocking it
 * would make `make dev-desktop` unable to install a floored host at all. It
 * is exempted BY NAME rather than by a range check, so the exemption cannot
 * widen: a real released version that happens to sort low is still refused.
 */
export type HostClientFloorVerdict =
  /** No floor declared for this version. */
  | { readonly kind: "unfloored" }
  | { readonly kind: "satisfied"; readonly requiredCliVersion: string }
  /** A local/dev build. Allowed, deliberately, and worth saying out loud. */
  | { readonly kind: "unreleased-cli"; readonly requiredCliVersion: string }
  | {
      readonly kind: "below-floor";
      readonly requiredCliVersion: string;
      readonly cliVersion: string;
    }
  /**
   * The manifest declared a floor that is not SemVer. The registry side of
   * the version domain must always be valid SemVer - incomparability is a
   * policy reserved for the INSTALLED side - so this is a data-integrity
   * failure, and it refuses rather than degrading to "no floor". Degrading
   * would make a typo in the publisher the way to disable the floor fleet-
   * wide, silently. `requiredCliVersion` here is the declared text BOUNDED
   * for rendering (`describeUnreadableFloor`), not the raw value.
   */
  | { readonly kind: "floor-unreadable"; readonly requiredCliVersion: string };

export type HostClientFloorInput = {
  readonly cliVersion: string;
  readonly requiredCliVersion: string | null;
};

export function evaluateHostClientFloor(
  input: HostClientFloorInput,
): HostClientFloorVerdict {
  const requiredCliVersion = input.requiredCliVersion;
  if (requiredCliVersion === null) return { kind: "unfloored" };
  if (!isValidHostVersion(requiredCliVersion)) {
    // Bounded HERE, at the verdict's construction, so every consumer of
    // the refusal - the message, the registry client's WARN lines, the
    // error's `details` - carries the same bounded text (see
    // `describeUnreadableFloor`).
    return {
      kind: "floor-unreadable",
      requiredCliVersion: describeUnreadableFloor(requiredCliVersion),
    };
  }
  if (input.cliVersion === LOCAL_CLI_VERSION) {
    return { kind: "unreleased-cli", requiredCliVersion };
  }
  const comparison = compareHostVersions(input.cliVersion, requiredCliVersion);
  // An unparseable CLI version is treated as below the floor. It cannot
  // happen from a released binary (the release tag is the source), and the
  // safe direction for "I cannot tell what I am" is to refuse.
  if (!comparison.comparable) {
    return {
      kind: "below-floor",
      requiredCliVersion,
      cliVersion: input.cliVersion,
    };
  }
  if (comparison.ordering === "less") {
    return {
      kind: "below-floor",
      requiredCliVersion,
      cliVersion: input.cliVersion,
    };
  }
  return { kind: "satisfied", requiredCliVersion };
}

/** The two verdicts that stop an install. */
export type HostClientFloorRefusal =
  | {
      readonly kind: "below-floor";
      readonly requiredCliVersion: string;
      readonly cliVersion: string;
    }
  | { readonly kind: "floor-unreadable"; readonly requiredCliVersion: string };

export function isHostClientFloorRefusal(
  verdict: HostClientFloorVerdict,
): verdict is HostClientFloorRefusal {
  return verdict.kind === "below-floor" || verdict.kind === "floor-unreadable";
}

export function hostClientFloorRefusalMessage(
  refusal: HostClientFloorRefusal,
  resolvedVersion: string,
): string {
  if (refusal.kind === "below-floor") {
    return `host registry: version '${resolvedVersion}' requires Traycer CLI ${refusal.requiredCliVersion} or newer, and this is ${refusal.cliVersion}. Update Traycer first, then install the host.`;
  }
  return `host registry: version '${resolvedVersion}' declares requiredCliVersion ${JSON.stringify(refusal.requiredCliVersion)}, which is not a version this CLI can compare against. The manifest is wrong; do not work around it by installing a different version.`;
}

// An unreadable floor is registry text this CLI could not parse. A valid
// floor is a bounded token by construction; this one is not, so the
// verdict carries it bounded - its charset (printable ASCII, the rest
// shown as `?`) and its length - and every render of the REFUSAL (the
// message, the WARN lines, `details`, the reason `host available` authors
// onto its one unsplittable JSON line and every GUI surface) inherits
// that bound. The catalog ENTRY itself travels as the manifest parsed it;
// the GUI renders no floor it cannot read as a version.
const UNREADABLE_FLOOR_RENDER_LIMIT = 64;

function describeUnreadableFloor(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, "?");
  if (printable.length <= UNREADABLE_FLOOR_RENDER_LIMIT) return printable;
  return `${printable.slice(0, UNREADABLE_FLOOR_RENDER_LIMIT)}... (${value.length} characters)`;
}
