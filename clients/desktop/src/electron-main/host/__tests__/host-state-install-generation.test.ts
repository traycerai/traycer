import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  attestedInstallGenerationFromDisk,
  type DesktopHostInstallRecord,
} from "../host-state";

// The desktop half of the Q3 cold review's F1 (reviewer B): one construction
// of the install generation, not six. The CLI's five sites were migrated in
// `bafc226ec`; this file is the sixth, and the one that talks across a process
// boundary - desktop main captures the fingerprint from disk and hands it to
// `host stamp-runtime`, whose CAS recomputes it in the CLI. The comparison
// means something only because both sides feed one encoder the whole record.
//
// A hand-rebuilt `{installId, installedAt, archiveSha256, version}` literal
// reintroduces a per-site mapping, and a mapping can drift with no type error.
// The resulting failure is silent AND fail-closed: the CAS stops matching and
// the activation it guards refuses, with nothing red anywhere.

function record(
  overrides: Partial<DesktopHostInstallRecord>,
): DesktopHostInstallRecord {
  return {
    installId: "install-1",
    version: "1.7.2",
    runtimeVersion: "1.7.2",
    installedAt: "2026-01-01T00:00:00.000Z",
    archiveSha256: "a".repeat(64),
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

describe("attestedInstallGenerationFromDisk", () => {
  it("delegates to the shared encoder for a minted record", () => {
    const minted = record({ installId: "install-42" });

    expect(attestedInstallGenerationFromDisk(minted)).toBe(
      encodeInstallGeneration(minted),
    );
    // The tagged form, so a drift into a local re-implementation is visible
    // rather than merely unequal to a value computed the same wrong way.
    expect(attestedInstallGenerationFromDisk(minted)).toBe("id:install-42");
  });

  it("delegates for a legacy record with no installId", () => {
    const legacy = record({ installId: null });

    expect(attestedInstallGenerationFromDisk(legacy)).toBe(
      encodeInstallGeneration(legacy),
    );
    expect(attestedInstallGenerationFromDisk(legacy)).toBe(
      `legacy:2026-01-01T00:00:00.000Z|${"a".repeat(64)}|1.7.2`,
    );
  });

  it("ignores the fields outside the identity, which is what makes 'pass the record' safe", () => {
    // A desktop record carries more than the four identity fields. If any of
    // them reached the fingerprint, passing the record would be unsafe advice
    // and every caller would need its own projection back.
    const base = record({});

    expect(
      attestedInstallGenerationFromDisk({
        ...base,
        runtimeVersion: "9.9.9",
        platform: "win32",
        arch: "x64",
      }),
    ).toBe(attestedInstallGenerationFromDisk(base));
  });

  // Source-level, for the same reason the shared suite's equivalent row is:
  // no behavioural test can observe HOW a caller built its argument. A correct
  // hand-rebuilt literal produces the identical string today - that is exactly
  // why the drift is silent - so the pin has to read the call site.
  it("passes the record to encodeInstallGeneration rather than rebuilding the literal", async () => {
    const source = await readFile(
      join(__dirname, "..", "host-state.ts"),
      "utf8",
    );

    expect(source).toContain("encodeInstallGeneration(record)");
    expect(source).not.toMatch(
      /encodeInstallGeneration\(\s*\{\s*\n?\s*installId:/,
    );
  });
});
