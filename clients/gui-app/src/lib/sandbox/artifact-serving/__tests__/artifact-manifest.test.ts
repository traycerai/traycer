import { describe, expect, it } from "vitest";
import {
  resolveManifestPath,
  type ArtifactManifest,
  type ArtifactManifestEntry,
} from "../artifact-manifest";

function entry(overrides: Partial<ArtifactManifestEntry>): ArtifactManifestEntry {
  return {
    sha256: "sha-1",
    byteLength: 10,
    mediaType: "text/plain",
    ...overrides,
  };
}

describe("resolveManifestPath", () => {
  it("returns the entry for a path that is present", () => {
    const target = entry({});
    const manifest: ArtifactManifest = { files: { "index.html": target } };
    expect(resolveManifestPath(manifest, "index.html")).toBe(target);
  });

  it("returns null for a path that is simply absent", () => {
    const manifest: ArtifactManifest = { files: { "index.html": entry({}) } };
    expect(resolveManifestPath(manifest, "missing.txt")).toBeNull();
  });

  it("returns null for every manifest's empty files map", () => {
    const manifest: ArtifactManifest = { files: {} };
    expect(resolveManifestPath(manifest, "index.html")).toBeNull();
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "misses %s when it is only inherited from Object.prototype, never an own key",
    (name) => {
      const manifest: ArtifactManifest = { files: { "index.html": entry({}) } };
      expect(resolveManifestPath(manifest, name)).toBeNull();
    },
  );

  it("still hits a path that happens to share a name with an Object.prototype member, once it is a real own key", () => {
    const target = entry({ sha256: "sha-shadow" });
    const manifest: ArtifactManifest = { files: { toString: target } };
    expect(resolveManifestPath(manifest, "toString")).toBe(target);
  });

  it.each(["", "../secret", ".hidden", "a/../b", "a\\b"])(
    "refuses the syntactically invalid path %j even when the manifest happens to hold that exact key",
    (badPath) => {
      const manifest: ArtifactManifest = {
        files: { [badPath]: entry({}) },
      };
      expect(resolveManifestPath(manifest, badPath)).toBeNull();
    },
  );
});
