import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeInstallGeneration } from "../install-generation";

describe("encodeInstallGeneration", () => {
  it("uses the installId when present, ignoring the legacy fields entirely", () => {
    const generation = encodeInstallGeneration({
      installId: "3f5b6c1a-1111-4c9a-9999-abcdefabcdef",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.2.3",
    });
    expect(generation).toBe("id:3f5b6c1a-1111-4c9a-9999-abcdefabcdef");
  });

  it("falls back to the legacy tuple when installId is null", () => {
    const generation = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.2.3",
    });
    expect(generation).toBe(
      `legacy:2026-01-01T00:00:00.000Z|${"a".repeat(64)}|1.2.3`,
    );
  });

  it("encodes a null archiveSha256 as an empty legacy-tuple segment", () => {
    const generation = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: null,
      version: "local-host.tar.gz-2026-01-01T00-00-00-000Z",
    });
    expect(generation).toBe(
      "legacy:2026-01-01T00:00:00.000Z||local-host.tar.gz-2026-01-01T00-00-00-000Z",
    );
  });

  it("is stable and deterministic for identical inputs", () => {
    const identity = {
      installId: null,
      installedAt: "2026-02-02T00:00:00.000Z",
      archiveSha256: "b".repeat(64),
      version: "2.0.0",
    };
    expect(encodeInstallGeneration(identity)).toBe(
      encodeInstallGeneration({ ...identity }),
    );
  });

  it("distinguishes two different legacy installs with the same version but different installedAt", () => {
    const first = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "c".repeat(64),
      version: "1.0.0",
    });
    const second = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-02T00:00:00.000Z",
      archiveSha256: "c".repeat(64),
      version: "1.0.0",
    });
    expect(first).not.toBe(second);
  });

  it("never collides an installId-shaped fingerprint with a legacy-tuple one", () => {
    // Deliberately construct a legacy tuple whose fields, if concatenated
    // without the tag prefix, could coincidentally resemble an installId
    // fingerprint - the `id:`/`legacy:` prefixes keep the two encodings in
    // disjoint namespaces regardless of field content.
    const legacy = encodeInstallGeneration({
      installId: null,
      installedAt: "id:not-actually-an-installId",
      archiveSha256: null,
      version: "1.0.0",
    });
    const minted = encodeInstallGeneration({
      installId: "not-actually-an-installId",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: null,
      version: "1.0.0",
    });
    expect(legacy).not.toBe(minted);
  });
});

describe("no caller rebuilds the identity literal (Q3 cold-review F1)", () => {
  // The two strings that MUST agree byte-for-byte: the claim baseline a park
  // records (`installGenerationOf`, host/update-run.ts) and the value the
  // supervisor-relaunch admission recomputes under the attempt lock
  // (commands/host-start.ts). They agree only because both hand the whole
  // record to one encoder.
  //
  // A hand-rebuilt `{installId, installedAt, archiveSha256, version}` literal
  // reintroduces a per-site field mapping, and a mapping is what can drift
  // with no type error - change which record field feeds `installedAt` at one
  // site and nothing catches it. The resulting failure is silent AND
  // fail-closed: comparisons stop matching, the exemption never fires,
  // `host start` exits 0 again while an update is parked, and the indefinite
  // outage that exemption exists to prevent comes back with nothing red.
  //
  // Source-level because that is where the authority is. This module cannot
  // observe how a caller in another package builds its argument, so the pin
  // reads the callers rather than pretending a behavioural test could see it.
  const CALLERS = [
    "host/update-run.ts",
    "host/provision.ts",
    "host/stamp-runtime.ts",
    "host/attested-install-runtime.ts",
    "commands/host-start.ts",
  ] as const;

  it.each(CALLERS)(
    "%s passes the record to encodeInstallGeneration rather than rebuilding it",
    async (relative) => {
      const cliSrc = resolve(__dirname, "../../../traycer-cli/src");
      const source = await readFile(join(cliSrc, relative), "utf8");

      expect(source).toContain("encodeInstallGeneration(");
      // The rebuilt-literal shape, in the only spelling it can take: an object
      // argument whose first key is `installId`.
      expect(source).not.toMatch(
        /encodeInstallGeneration\(\s*\{\s*\n?\s*installId:/,
      );
    },
  );

  it("agrees with itself whether handed a bare identity or a whole install record", () => {
    const identity = {
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "d".repeat(64),
      version: "1.3.0-rc.1",
    } as const;
    // A record carries far more than the four fields. Extra properties must
    // not change the fingerprint, or "pass the record" would not be safe
    // advice and every caller would need its own projection again.
    const record = {
      ...identity,
      runtimeVersion: "1.3.0-rc.1",
      platform: "darwin",
      arch: "arm64",
      signatureVerifiedAt: "2026-01-01T00:00:01.000Z",
      signatureKeyId: "key-1",
      sizeBytes: 1234,
      executablePath: "bin/traycer-host",
      executableSha256: null,
    };

    expect(encodeInstallGeneration(record)).toBe(
      encodeInstallGeneration(identity),
    );
  });
});
