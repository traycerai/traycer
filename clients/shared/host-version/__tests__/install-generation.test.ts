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
