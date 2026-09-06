import {
  compareHostVersions,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";

/**
 * What the INSTALL and STAGED records say about an update the legacy path has
 * parked — facts the coarse `updateProgress` marker cannot carry, because the
 * legacy updater withdraws its marker when a busy host makes it stop.
 *
 * Two parks, both real states a person needs to see and act on:
 *
 * - **Activation debt**: `install.json` names a version the running process is
 *   not. Bytes were swapped by an actor that could not (or, refused as busy,
 *   did not) restart the host — Desktop's launch converge, or `traycer host
 *   update` declining to interrupt live work. The only way forward is a
 *   restart, and the Overview offers it.
 * - **Staged wait**: a newer host sits in `staged/` while the running host is
 *   busy. The updater downloaded it, found work in progress, and left it for
 *   the next idle run (or a forced one). The Overview says so and offers the
 *   force.
 *
 * Derived CLIENT-SIDE from `host.getInstallationInfo` + `host.status`, on
 * purpose: both reads are already on the page, no host release is needed, and
 * a remote host is described exactly as a local one. The cost is that these
 * facts refresh at the installation-info poll's cadence, which is why that
 * method polls at all.
 */
export interface LegacyUpdateFacts {
  readonly activationDebt: { readonly installedVersion: string } | null;
  readonly stagedWait: {
    readonly stagedVersion: string;
    /**
     * From the SAME `host.status` read as `busy`. `null` when the host is busy
     * but counts no session — a claim, not work — so the sentence stays
     * unquantified rather than promising that "0 sessions" will finish.
     */
    readonly blockingSessionCount: number | null;
  } | null;
}

/** The two records, in the minimum shape both wire minors satisfy. */
export type LegacyUpdateInstallation =
  | { readonly status: "unmanaged" }
  | {
      readonly status: "managed";
      readonly installRecord: {
        readonly version: string;
        readonly runtimeVersion: string | null;
      };
      readonly stagedRecord: { readonly version: string } | null;
    };

export const NO_LEGACY_UPDATE_FACTS: LegacyUpdateFacts = {
  activationDebt: null,
  stagedWait: null,
};

/**
 * Mirrors the CLI's `readActivationState` (`commands/host-update.ts`) rule for
 * rule, so the Overview and the updater agree about what debt IS:
 *
 * | Install record          | Running version                                 | Debt |
 * | ----------------------- | ----------------------------------------------- | ---- |
 * | `runtimeVersion` set    | equal to the stamp                              | no   |
 * | `runtimeVersion` set    | anything else (either direction, SemVer or not) | yes  |
 * | no `runtimeVersion`     | not valid SemVer (a foreign runtime)            | no   |
 * | no `runtimeVersion`     | comparable to `version` and unequal             | yes  |
 * | no `runtimeVersion`     | equal, or incomparable                          | no   |
 * | `unmanaged` / no record | anything                                        | no   |
 *
 * The runtime-stamp domain is EQUALITY, never ordering: a staging host's stamp
 * is `staging.<epoch>.<sha>`, and a SemVer guard in front of that comparison
 * would classify every staging host as foreign. The catalog-version fallback
 * (a record with no stamp yet) keeps the CLI's release-version policy, under
 * which `0.0.0-dev` IS valid SemVer and a dev host beside a `1.3.0` record reads
 * as debt — the same answer the CLI gives, stated here so nobody "fixes" it on
 * one side only.
 *
 * Desktop's `deriveActivationState` is deliberately NOT mirrored: it has no
 * SemVer fallback and reports a stamp-less record as `activationUnknown`, which
 * the landing banner treats as debt. That widening stays the banner's; a
 * cross-reader unification is a separate decision.
 */
export function deriveLegacyUpdateFacts(input: {
  readonly installation: LegacyUpdateInstallation | null;
  readonly runningVersion: string;
  readonly busy: boolean;
  readonly busySessionCount: number | null;
}): LegacyUpdateFacts {
  const { installation } = input;
  if (installation === null || installation.status !== "managed") {
    return NO_LEGACY_UPDATE_FACTS;
  }
  const installed = installation.installRecord;
  const activationDebt = isActivationDebt(installed, input.runningVersion)
    ? { installedVersion: installed.version }
    : null;
  const staged = installation.stagedRecord;
  const stagedWait =
    staged !== null && staged.version !== installed.version && input.busy
      ? {
          stagedVersion: staged.version,
          blockingSessionCount:
            input.busySessionCount !== null && input.busySessionCount > 0
              ? input.busySessionCount
              : null,
        }
      : null;
  return { activationDebt, stagedWait };
}

function isActivationDebt(
  installed: {
    readonly version: string;
    readonly runtimeVersion: string | null;
  },
  runningVersion: string,
): boolean {
  if (installed.runtimeVersion !== null) {
    return runningVersion !== installed.runtimeVersion;
  }
  if (!isValidHostVersion(runningVersion)) return false;
  const comparison = compareHostVersions(runningVersion, installed.version);
  return comparison.comparable && comparison.ordering !== "equal";
}
