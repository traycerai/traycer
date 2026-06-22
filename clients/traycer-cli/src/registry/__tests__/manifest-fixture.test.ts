import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseHostVersionsManifest,
  parseHostVersionsManifestWithWarnings,
} from "../manifest-schema";

// NP-9 fixture-based parser test. The committed fixture at
// scripts/native-packaging/fixtures/versions-example.json is also what
// scripts/native-packaging/validate-manifest-fixture.cjs feeds into the
// release-time pre-publish check; pinning a parser test against the
// same file gives us a fast unit signal when either the schema or the
// fixture drifts.

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "native-packaging",
  "fixtures",
  "versions-example.json",
);

describe("host registry manifest fixture", () => {
  it("parses the committed versions-example.json fixture", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const parsed = parseHostVersionsManifest(raw, FIXTURE_PATH);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.latest).toBe("1.5.0");
    expect(parsed.versions.length).toBeGreaterThanOrEqual(2);
    const yanked = parsed.versions.find((v) => v.yanked);
    expect(yanked).toBeDefined();
    expect(yanked?.deprecationReason).toMatch(/.+/);
  });

  it("drops (skip-and-warn) a fixture entry whose sha256 is not lower-case hex", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const droppedVersion = raw.versions[0].version;
    raw.versions[0].platforms["darwin-arm64"].sha256 = "NOTHEX";
    // A bad sha256 fails that entry's validation, so skip-and-warn drops the
    // entry (it does NOT top-level reject the whole manifest); the rest still
    // parses and `latest` falls back off the dropped entry.
    const result = parseHostVersionsManifestWithWarnings(raw, "tampered");
    expect(result.manifest.versions.map((v) => v.version)).not.toContain(
      droppedVersion,
    );
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a fixture whose latest does not appear in versions[]", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    raw.latest = "9.9.9";
    expect(() => parseHostVersionsManifest(raw, "tampered")).toThrow();
  });
});
