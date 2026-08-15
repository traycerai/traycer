import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallationDetailsDisclosure,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";

/**
 * `InstallationDetailsDisclosure` gained `signatureKeyId` on its record, and
 * the Verification caption now reads it ALONGSIDE `signatureVerifiedAt` rather
 * than that field alone. No suite renders this component directly yet, so
 * this is the small, focused component test the field's own doc comment
 * describes: a plain render + open, not the full `<HostSettingsPanel />`
 * harness the RPC-backed Overview suites use.
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

function renderOpenVerification(
  record: InstallationDetailsRecord,
): HTMLElement {
  render(
    <InstallationDetailsDisclosure
      record={record}
      loading={false}
      emptyMessage="unused"
    />,
  );
  // Closed by default (`HostSettingsDisclosure`'s own `defaultOpen={false}`) —
  // Radix does not mount `CollapsibleContent` while closed, so the caption
  // only reaches the DOM once this fires.
  fireEvent.click(
    screen.getByRole("button", { name: /Installation details/i }),
  );
  return screen.getByTestId("settings-host-verification");
}

describe("<InstallationDetailsDisclosure /> Verification caption", () => {
  it("reads 'Unsigned local build' in amber for the CLI's unsigned sentinel key, never a green Verified", () => {
    // Pins the regression `signatureKeyId` exists to fix: an unsigned
    // local-file install stamps `signatureVerifiedAt` with the install time
    // anyway (`stageLocalSource` / `remote-host-staging.js`), so reading that
    // field alone captioned every hand-installed or tree-run host with a
    // green "Verified <date>" for a signature that was never checked.
    const field = renderOpenVerification(
      installRecord({
        signatureKeyId: "local-file:unsigned",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      }),
    );
    expect(field.textContent).toBe("Unsigned local build");
    expect(field.classList.contains("text-amber-500")).toBe(true);
    expect(field.classList.contains("text-emerald-500")).toBe(false);
  });

  it("reads 'Verified <date>' in emerald when a real key verified the archive", () => {
    const field = renderOpenVerification(
      installRecord({
        signatureKeyId: "key-1",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      }),
    );
    expect(field.textContent).toMatch(/^Verified /);
    expect(field.classList.contains("text-emerald-500")).toBe(true);
    expect(field.classList.contains("text-amber-500")).toBe(false);
  });

  it("reads 'Unverified' when signatureVerifiedAt is null and the key isn't the unsigned sentinel", () => {
    const field = renderOpenVerification(
      installRecord({
        signatureKeyId: "key-1",
        signatureVerifiedAt: null,
      }),
    );
    expect(field.textContent).toBe("Unverified");
    expect(field.classList.contains("text-amber-500")).toBe(true);
    expect(field.classList.contains("text-emerald-500")).toBe(false);
  });
});
