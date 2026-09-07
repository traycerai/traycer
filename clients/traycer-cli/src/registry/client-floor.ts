import {
  compareHostVersions,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { LOCAL_CLI_VERSION } from "../cli-version";

/** Host manifest client floor, enforced. A CLI below the floor must not download that host. */
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
  /** The manifest declared a floor that is not SemVer. The registry side of the version domain must always be valid SemVer - incomparability is a policy reserved for the INSTALLED side - so this is a data-integrity failure, and it refuses rather than degrading to "no floor". */
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
    return { kind: "floor-unreadable", requiredCliVersion };
  }
  if (input.cliVersion === LOCAL_CLI_VERSION) {
    return { kind: "unreleased-cli", requiredCliVersion };
  }
  const comparison = compareHostVersions(input.cliVersion, requiredCliVersion);
  // An unparseable CLI version is treated as below the floor.
  // It cannot happen from a released binary (the release tag is the source), and the safe direction for "I cannot tell what I am" is to refuse.
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
