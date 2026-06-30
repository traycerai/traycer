import { describe, expect, it } from "vitest";
import {
  parseHostVersionsManifest,
  parseHostVersionsManifestWithWarnings,
} from "../manifest-schema";
import { CliError } from "../../runner/errors";

const VALID_MANIFEST = {
  schemaVersion: 1,
  generatedAt: "2026-05-15T12:00:00Z",
  latest: "1.5.0",
  versions: [
    {
      version: "1.5.0",
      releasedAt: "2026-05-15T12:00:00Z",
      releaseNotesUrl: "https://example.com/notes/1.5.0",
      yanked: false,
      deprecationReason: null,
      requiredCliVersion: null,
      platforms: {
        "darwin-arm64": {
          available: true,
          unavailableReason: null,
          url: "https://example.com/host-1.5.0-darwin-arm64.tar.gz",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          signatureUrl:
            "https://example.com/host-1.5.0-darwin-arm64.tar.gz.minisig",
          signatureAlgorithm: "minisign",
          publicKeyId: "deadbeefdeadbeef",
        },
        "linux-x64": {
          available: false,
          unavailableReason: "not built for this release",
          url: "",
          sizeBytes: 0,
          sha256: "",
          signatureUrl: "",
          signatureAlgorithm: "minisign",
          publicKeyId: "",
        },
      },
    },
  ],
};

describe("parseHostVersionsManifest", () => {
  it("accepts a well-formed manifest", () => {
    const parsed = parseHostVersionsManifest(VALID_MANIFEST, "test://valid");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.latest).toBe("1.5.0");
    expect(parsed.versions).toHaveLength(1);
    const entry = parsed.versions[0];
    expect(entry?.platforms["darwin-arm64"]?.available).toBe(true);
    expect(entry?.platforms["linux-x64"]?.available).toBe(false);
  });

  it("rejects an unsupported schemaVersion", () => {
    const bad = { ...VALID_MANIFEST, schemaVersion: 2 };
    expect(() => parseHostVersionsManifest(bad, "test://bad-schema")).toThrow(
      CliError,
    );
  });

  it("rejects a manifest where latest is not in versions[]", () => {
    const bad = { ...VALID_MANIFEST, latest: "9.9.9" };
    expect(() => parseHostVersionsManifest(bad, "test://bad-latest")).toThrow(
      /'latest=9.9.9' does not appear/,
    );
  });

  it("skips a non-latest entry with invalid sha256 and surfaces a warning", () => {
    const bad = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad.versions.push({
      ...bad.versions[0],
      version: "1.4.9",
      platforms: {
        ...bad.versions[0].platforms,
        "darwin-arm64": {
          ...bad.versions[0].platforms["darwin-arm64"],
          sha256: "nothex",
        },
      },
    });
    const result = parseHostVersionsManifestWithWarnings(bad, "test://bad-sha");
    expect(result.manifest.versions.map((v) => v.version)).toEqual(["1.5.0"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/sha256/);
  });

  it("skips a non-latest entry with an unknown platform key and surfaces a warning", () => {
    const bad = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad.versions.push({
      ...bad.versions[0],
      version: "1.4.9",
      platforms: {
        "sunos-sparc": bad.versions[0].platforms["darwin-arm64"],
      },
    });
    const result = parseHostVersionsManifestWithWarnings(
      bad,
      "test://bad-plat",
    );
    expect(result.manifest.versions.map((v) => v.version)).toEqual(["1.5.0"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/platform key 'sunos-sparc'/);
  });

  it("skips duplicate version entries with a warning rather than aborting", () => {
    const bad = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad.versions.push(bad.versions[0]);
    const result = parseHostVersionsManifestWithWarnings(bad, "test://dup");
    expect(result.manifest.versions).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/duplicate version entry/);
  });

  it("skips a malformed entry with a warning rather than aborting the whole manifest", () => {
    const mixed = JSON.parse(JSON.stringify(VALID_MANIFEST));
    // Add a future entry where `yanked` is missing - the kind of drift
    // that should not soft-brick every install of every other version.
    mixed.versions.push({
      version: "2.0.0-beta.1",
      releasedAt: "2026-06-01T00:00:00Z",
      releaseNotesUrl: "https://example.com/notes/2.0.0-beta.1",
      // yanked: missing on purpose
      deprecationReason: null,
      requiredCliVersion: null,
      platforms: {},
    });
    const result = parseHostVersionsManifestWithWarnings(
      mixed,
      "test://skip-and-warn",
    );
    expect(result.manifest.versions.map((v) => v.version)).toEqual(["1.5.0"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.entryIndex).toBe(1);
    expect(result.warnings[0]?.message).toMatch(/yanked/);
  });

  it("throws when latest names a malformed entry and NO other usable version remains", () => {
    // The only version entry is the one `latest` points at, and it is
    // malformed (skip-and-warn drops it), leaving zero usable versions. With
    // nothing to fall back to this is a genuine top-level failure.
    const bad = {
      schemaVersion: 1,
      generatedAt: "2026-06-01T00:00:00Z",
      latest: "2.0.0-beta.1",
      versions: [
        {
          version: "2.0.0-beta.1",
          releasedAt: "2026-06-01T00:00:00Z",
          releaseNotesUrl: "https://example.com/notes/2.0.0-beta.1",
          // yanked: missing - malformed entry, skip-and-warn drops it.
          deprecationReason: null,
          requiredCliVersion: null,
          platforms: {},
        },
      ],
    };
    expect(() =>
      parseHostVersionsManifest(bad, "test://latest-malformed"),
    ).toThrow(/names a dropped entry and no usable version/);
  });

  it("falls back (does NOT brick) when latest names a malformed entry but other versions survive", () => {
    // Forward-compat: a newer host wrote the `latest` entry in a shape this
    // CLI can't parse, so skip-and-warn drops it - but older, parseable
    // versions remain. The parser must NOT hard-fail the whole manifest (which
    // would brick every install path on a single bad entry); it repoints
    // `latest` to the newest surviving non-yanked version and warns.
    const mixed = JSON.parse(JSON.stringify(VALID_MANIFEST));
    mixed.latest = "2.0.0-beta.1";
    mixed.versions.unshift({
      version: "2.0.0-beta.1",
      releasedAt: "2026-06-01T00:00:00Z",
      releaseNotesUrl: "https://example.com/notes/2.0.0-beta.1",
      // yanked: missing - malformed, dropped by skip-and-warn.
      deprecationReason: null,
      requiredCliVersion: null,
      platforms: {},
    });
    const result = parseHostVersionsManifestWithWarnings(
      mixed,
      "test://latest-malformed-with-fallback",
    );
    // The malformed entry is dropped; 1.5.0 survives and becomes latest.
    expect(result.manifest.versions.map((v) => v.version)).toEqual(["1.5.0"]);
    expect(result.manifest.latest).toBe("1.5.0");
    expect(
      result.warnings.some((w) => w.message.includes("failed to parse")),
    ).toBe(true);
  });

  it("preserves yanked + deprecationReason fields", () => {
    const yanked = JSON.parse(JSON.stringify(VALID_MANIFEST));
    yanked.versions[0].yanked = true;
    yanked.versions[0].deprecationReason = "CVE-2026-9999";
    const parsed = parseHostVersionsManifest(yanked, "test://yanked");
    expect(parsed.versions[0]?.yanked).toBe(true);
    expect(parsed.versions[0]?.deprecationReason).toBe("CVE-2026-9999");
  });
});
