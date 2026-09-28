import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallRecordGroup,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";

/**
 * `InstallRecordGroup`'s record carries `signatureKeyId`, and the Verification
 * caption reads it ALONGSIDE `signatureVerifiedAt` rather than that field
 * alone. This is the small, focused component test that field's own doc
 * comment describes: a plain render, not the full `<HostSettingsPanel />`
 * harness the RPC-backed Overview suites use. The group is shown open, so
 * there is nothing to click before the caption is in the tree.
 */

afterEach(() => {
  cleanup();
});

function installRecord(
  overrides: Partial<InstallationDetailsRecord>,
): InstallationDetailsRecord {
  return {
    version: "1.5.0",
    // Set explicitly rather than left to the spread: an OMITTED field would be
    // `undefined`, not `null`, and the panel's `runtimeVersion === null` guard
    // reads those differently — a fixture that skipped it would exercise the
    // wrong branch while looking like the default one.
    runtimeVersion: null,
    installedAt: "2026-08-01T00:00:00Z",
    source: { kind: "registry", value: "1.5.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-01T00:00:00Z",
    signatureKeyId: "key-1",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

function renderVerification(record: InstallationDetailsRecord): HTMLElement {
  render(
    <InstallRecordGroup
      hostName="Build Box"
      degrade={null}
      record={record}
      loading={false}
      readFailed={false}
    />,
  );
  return screen.getByTestId("settings-host-verification");
}

describe("<InstallRecordGroup /> Verification caption", () => {
  it("reads 'Unsigned local build' in amber for the CLI's unsigned sentinel key, never a green Verified", () => {
    // Pins the regression `signatureKeyId` exists to fix: an unsigned
    // local-file install stamps `signatureVerifiedAt` with the install time
    // anyway (`stageLocalSource` / `remote-host-staging.js`), so reading that
    // field alone captioned every hand-installed or tree-run host with a
    // green "Verified <date>" for a signature that was never checked.
    const field = renderVerification(
      installRecord({
        signatureKeyId: "local-file:unsigned",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      }),
    );
    expect(field.textContent).toBe("Unsigned local build");
    expect(field.classList.contains("text-warning-foreground")).toBe(true);
    expect(field.classList.contains("text-success-foreground")).toBe(false);
  });

  it("reads 'Verified <date>' in emerald when a real key verified the archive", () => {
    const field = renderVerification(
      installRecord({
        signatureKeyId: "key-1",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      }),
    );
    expect(field.textContent).toMatch(/^Verified /);
    expect(field.classList.contains("text-success-foreground")).toBe(true);
    expect(field.classList.contains("text-warning-foreground")).toBe(false);
  });

  it("reads 'Unverified' when signatureVerifiedAt is null and the key isn't the unsigned sentinel", () => {
    const field = renderVerification(
      installRecord({
        signatureKeyId: "key-1",
        signatureVerifiedAt: null,
      }),
    );
    expect(field.textContent).toBe("Unverified");
    expect(field.classList.contains("text-warning-foreground")).toBe(true);
    expect(field.classList.contains("text-success-foreground")).toBe(false);
  });
});
