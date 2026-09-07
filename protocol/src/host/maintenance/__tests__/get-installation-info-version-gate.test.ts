import { describe, expect, it } from "vitest";
import {
  hostGetInstallationInfoUpgradeV10ToV11,
  hostGetInstallationInfoV10,
  hostGetInstallationInfoV11,
} from "../contracts";

// `host.update.install@1.0` - `host.getInstallationInfo` - the `@1.0` freeze and the `@1.1` growth.
// The fix is a version split, not a filter.

const SHA = "a".repeat(64);

/** What a resolver builds: the full, current record shape. */
const MANAGED_WITH_ATTESTATION = {
  status: "managed" as const,
  installRecord: {
    installId: "install-1",
    version: "1.2.0",
    runtimeVersion: "1.2.0",
    platform: "darwin" as const,
    arch: "arm64" as const,
    installedAt: "2026-08-27T00:00:00.000Z",
    source: { kind: "registry" as const, value: "1.2.0" },
    archiveSha256: null,
    signatureVerifiedAt: "2026-08-27T00:00:00.000Z",
    signatureKeyId: "key-1",
    sizeBytes: 1024,
    executablePath: "/tmp/host",
    executableSha256: SHA,
  },
  stagedRecord: {
    schemaVersion: 1 as const,
    stageId: "stage-1",
    version: "1.2.0",
    runtimeVersion: "1.2.0",
    archiveSha256: null,
    sizeBytes: 1024,
    source: { kind: "registry" as const, value: "1.2.0" },
    signatureKeyId: "key-1",
    signatureVerifiedAt: "2026-08-27T00:00:00.000Z",
    executablePath: "/tmp/staged",
    platform: "darwin" as const,
    arch: "arm64" as const,
    executableSha256: SHA,
  },
  cliManifest: null,
};

describe("host.getInstallationInfo@1.0 — the frozen released line", () => {
  it("STRIPS executableSha256 from the install record", () => {
    const parsed = hostGetInstallationInfoV10.responseSchema.parse(
      MANAGED_WITH_ATTESTATION,
    );
    if (parsed.status !== "managed") throw new Error("expected managed");
    // `not.toHaveProperty`, not `toBeNull`: the released line carries NO KEY at
    // all, and a `null` would still be a wire shape that peer never saw.
    expect(parsed.installRecord).not.toHaveProperty("executableSha256");
  });

  it("STRIPS executableSha256 from the staged record", () => {
    const parsed = hostGetInstallationInfoV10.responseSchema.parse(
      MANAGED_WITH_ATTESTATION,
    );
    if (parsed.status !== "managed") throw new Error("expected managed");
    expect(parsed.stagedRecord).not.toBeNull();
    expect(parsed.stagedRecord).not.toHaveProperty("executableSha256");
  });

  it("keeps every OTHER field of both records intact", () => {
    // The freeze removes exactly one key.
    const parsed = hostGetInstallationInfoV10.responseSchema.parse(
      MANAGED_WITH_ATTESTATION,
    );
    if (parsed.status !== "managed") throw new Error("expected managed");
    expect(parsed.installRecord.version).toBe("1.2.0");
    expect(parsed.installRecord.executablePath).toBe("/tmp/host");
    expect(parsed.installRecord.signatureKeyId).toBe("key-1");
    expect(parsed.stagedRecord?.version).toBe("1.2.0");
    expect(parsed.stagedRecord?.stageId).toBe("stage-1");
    expect(parsed.stagedRecord?.executablePath).toBe("/tmp/staged");
  });
});

describe("host.getInstallationInfo@1.1 — the growth", () => {
  it("CARRIES executableSha256 on both records", () => {
    const parsed = hostGetInstallationInfoV11.responseSchema.parse(
      MANAGED_WITH_ATTESTATION,
    );
    if (parsed.status !== "managed") throw new Error("expected managed");
    expect(parsed.installRecord.executableSha256).toBe(SHA);
    expect(parsed.stagedRecord?.executableSha256).toBe(SHA);
  });

  it("the upgrade reports null rather than inventing an attestation", () => {
    // A `@1.0` host never sent the field, so the bridge must not claim one.
    const v10 = hostGetInstallationInfoV10.responseSchema.parse(
      MANAGED_WITH_ATTESTATION,
    );
    const upgraded =
      hostGetInstallationInfoUpgradeV10ToV11.upgradeResponse(v10);
    if (upgraded.status !== "managed") throw new Error("expected managed");
    expect(upgraded.installRecord.executableSha256).toBeNull();
    expect(upgraded.stagedRecord?.executableSha256).toBeNull();
  });

  it("the upgrade leaves the unmanaged arm alone", () => {
    const upgraded = hostGetInstallationInfoUpgradeV10ToV11.upgradeResponse({
      status: "unmanaged",
    });
    expect(upgraded).toEqual({ status: "unmanaged" });
  });
});
