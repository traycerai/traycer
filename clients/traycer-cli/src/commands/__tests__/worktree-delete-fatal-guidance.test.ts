import { describe, expect, it } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { fatalCloseToCliError } from "../worktree-delete";

/**
 * WHAT A CLI USER READS when a worktree-delete stream closes fatally.
 *
 * The epoch rejection's `reason` is authored by the host and says, verbatim,
 * "Updating the host again will not help." This mapper used to append
 * "- update the host or CLI so their worktree delete versions match" to every
 * INCOMPATIBLE, producing one sentence that told the user two opposite things
 * and made the wrong one look actionable.
 *
 * The generic tail is still correct for every OTHER incompatibility - a
 * manifest disagreement genuinely can be either side's fault - so these specs
 * pin both arms rather than just the new one.
 */

const EPOCH_REASON =
  "This Traycer client is too old for this host. Update the Traycer app or " +
  "CLI to 1.2.0-rc.2 or newer. Updating the host again will not help. Do not " +
  "reset Traycer; your agents and history remain stored.";

function epochFatal(): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: EPOCH_REASON,
    incompatibleMethods: null,
    upgradeGuidance: { clientShouldUpgrade: true, hostShouldUpgrade: false },
    retryable: false,
    clientCompatibilityRequirement: {
      minimumCompatibilityEpoch: 2,
      observedCompatibilityEpoch: 1,
      failure: "below-minimum",
      observedClientKind: "cli",
      observedClientAppVersion: "1.1.10",
      observedClientAppVersionStatus: "valid",
      minimumKnownClientAppVersion: "1.2.0-rc.2",
      upgradeChannel: "rc",
    },
  };
}

function manifestFatal(): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: "worktree.deleteBatch is not supported by this host",
    incompatibleMethods: [
      {
        method: "worktree.deleteBatch",
        clientCanonical: { major: 1, minor: 0 },
        hostCanonical: null,
        blocking: "host-missing-method",
      },
    ],
    upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
  };
}

describe("worktree-delete fatal close -> CLI guidance", () => {
  it("never tells a user to update the host on an EPOCH rejection", () => {
    const error = fatalCloseToCliError(epochFatal());
    // The contradiction, asserted as an absence rather than by matching the
    // whole string: the host already said updating it will not help.
    expect(error.message).not.toContain("update the host or CLI");
    expect(error.message).toContain("Updating the host again will not help");
  });

  it("names the observed version, the required generation, and the build to install", () => {
    const error = fatalCloseToCliError(epochFatal());
    expect(error.message).toContain("1.1.10");
    expect(error.message).toContain("generation 1");
    expect(error.message).toContain("requires 2");
    expect(error.message).toContain("1.2.0-rc.2");
    expect(error.message).toContain("rc channel");
  });

  it("exits nonzero once with the incompatibility code", () => {
    const error = fatalCloseToCliError(epochFatal());
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe("E_HOST_INCOMPATIBLE");
  });

  it("KEEPS the generic tail for a manifest incompatibility", () => {
    // The fix must not widen. Here either side may be the stale one, and the
    // host's reason says nothing about which.
    const error = fatalCloseToCliError(manifestFatal());
    expect(error.message).toContain("update the host or CLI");
    expect(error.code).toBe("E_HOST_INCOMPATIBLE");
  });

  it("keeps the generic tail when a host predating the gate sends no requirement", () => {
    const error = fatalCloseToCliError({
      code: "INCOMPATIBLE",
      reason: "versions disagree",
      incompatibleMethods: null,
      upgradeGuidance: null,
    });
    expect(error.message).toContain("update the host or CLI");
  });

  it("leaves UNAUTHORIZED and unexpected closes untouched", () => {
    const auth = fatalCloseToCliError({
      code: "UNAUTHORIZED",
      reason: "bad bearer",
      incompatibleMethods: null,
      upgradeGuidance: null,
    });
    expect(auth.code).toBe("E_AUTH_REJECTED");
    const other = fatalCloseToCliError({
      code: "STREAM_PROTOCOL_ERROR",
      reason: "malformed frame",
      incompatibleMethods: null,
      upgradeGuidance: null,
    });
    expect(other.code).toBe("E_UNEXPECTED");
  });
});
