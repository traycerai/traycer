import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopHeldHostVersion } from "../host-state";
import { freshHostFsLayout } from "./host-fs-layout-test-support";

// Ticket 4's desktop-local mirror-reader (installId-bound): `readDesktopHeldHostVersion`
// reads the CLI-owned `held-host-version.json` the same tolerant way
// `readDesktopHostInstallRecord`/`readDesktopHostStagedRecord` read their own
// sidecars - a missing or malformed record (including one missing `installId`,
// a legacy pre-binding shape) must fail safe toward "nothing held", never
// wedge the launch converge gate on a corrupt file.
describe("readDesktopHeldHostVersion", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
    roots.length = 0;
  });

  it("returns null when the record file does not exist", async () => {
    const layout = await freshHostFsLayout(roots, "held-version-missing-");

    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const layout = await freshHostFsLayout(roots, "held-version-malformed-");
    await writeFile(layout.heldVersionRecordFile, "{not json", "utf8");

    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();
  });

  it("returns null when the JSON is not a plain object", async () => {
    const layout = await freshHostFsLayout(roots, "held-version-non-object-");
    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify("1.2.0"),
      "utf8",
    );

    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();
  });

  it("returns null when `version` is missing or not a non-empty string", async () => {
    const layout = await freshHostFsLayout(roots, "held-version-bad-field-");
    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ installId: "install-a" }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();

    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: "", installId: "install-a" }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();

    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: 123, installId: "install-a" }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();
  });

  // installId-binding: a record naming a valid `version` but missing (or
  // non-string / empty) `installId` cannot be matched against any install
  // instance and so must read as "nothing held" - never fall back to a
  // version-only match. This is the shape a legacy (pre-binding) record has.
  it("returns null when `installId` is missing or not a non-empty string", async () => {
    const layout = await freshHostFsLayout(
      roots,
      "held-version-bad-install-id-",
    );
    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: "1.2.0" }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();

    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: "1.2.0", installId: "" }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();

    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: "1.2.0", installId: 123 }),
      "utf8",
    );
    await expect(readDesktopHeldHostVersion(layout)).resolves.toBeNull();
  });

  it("returns the held { version, installId } for a valid record", async () => {
    const layout = await freshHostFsLayout(roots, "held-version-valid-");
    await mkdir(layout.rootDir, { recursive: true });
    await writeFile(
      layout.heldVersionRecordFile,
      JSON.stringify({ version: "1.2.0", installId: "install-a" }),
      "utf8",
    );

    await expect(readDesktopHeldHostVersion(layout)).resolves.toEqual({
      version: "1.2.0",
      installId: "install-a",
    });
  });
});
