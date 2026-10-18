import { describe, expect, it } from "vitest";
import {
  buildArtifactAddress,
  newMountId,
  parseArtifactAddress,
} from "../artifact-address";

const SCHEME = "traycer-artifact";
const MOUNT = "abcdef1234567890";

describe("parseArtifactAddress", () => {
  it.each<[string, string, { artifactId: string; mountId: string; path: string }]>([
    [
      "a plain path",
      `${SCHEME}://artifact-myart123--${MOUNT}/assets/logo.png`,
      { artifactId: "myart123", mountId: MOUNT, path: "assets/logo.png" },
    ],
    [
      "no path at all",
      `${SCHEME}://artifact-myart123--${MOUNT}`,
      { artifactId: "myart123", mountId: MOUNT, path: "index.html" },
    ],
    [
      "a trailing slash only",
      `${SCHEME}://artifact-myart123--${MOUNT}/`,
      { artifactId: "myart123", mountId: MOUNT, path: "index.html" },
    ],
    [
      "a percent-encoded space",
      `${SCHEME}://artifact-myart123--${MOUNT}/file%20name.txt`,
      { artifactId: "myart123", mountId: MOUNT, path: "file name.txt" },
    ],
    [
      "a trailing dot in a segment (not a dot-segment)",
      `${SCHEME}://artifact-myart123--${MOUNT}/foo.`,
      { artifactId: "myart123", mountId: MOUNT, path: "foo." },
    ],
    [
      "an underscore in the artifact id",
      `${SCHEME}://artifact-my_art_1--${MOUNT}/x`,
      { artifactId: "my_art_1", mountId: MOUNT, path: "x" },
    ],
    [
      "a query string and hash, both ignored",
      `${SCHEME}://artifact-myart123--${MOUNT}/x?y=1#z`,
      { artifactId: "myart123", mountId: MOUNT, path: "x" },
    ],
    [
      "unicode in the path",
      `${SCHEME}://artifact-myart123--${MOUNT}/caf%C3%A9.txt`,
      { artifactId: "myart123", mountId: MOUNT, path: "café.txt" },
    ],
  ])("parses %s", (_label, url, expected) => {
    expect(parseArtifactAddress(url)).toEqual(expected);
  });

  it("merges a percent-encoded slash into an extra segment after its one decode pass", () => {
    // Decoding happens once, before segment validation, so %2F is
    // indistinguishable from a literal "/" by the time isArtifactPath runs.
    expect(
      parseArtifactAddress(`${SCHEME}://artifact-myart123--${MOUNT}/a%2Fb.txt`),
    ).toEqual({ artifactId: "myart123", mountId: MOUNT, path: "a/b.txt" });
  });

  it.each<[string, string]>([
    ["a literal .. segment", `${SCHEME}://artifact-myart123--${MOUNT}/../secret`],
    [
      "a percent-encoded .. segment",
      `${SCHEME}://artifact-myart123--${MOUNT}/%2e%2e/secret`,
    ],
    ["a single . segment", `${SCHEME}://artifact-myart123--${MOUNT}/./foo`],
    [
      "a segment that merely starts with a dot",
      `${SCHEME}://artifact-myart123--${MOUNT}/a/.hidden`,
    ],
    [
      "a literal backslash",
      `${SCHEME}://artifact-myart123--${MOUNT}/foo\\bar`,
    ],
    [
      "a percent-encoded backslash",
      `${SCHEME}://artifact-myart123--${MOUNT}/foo%5Cbar`,
    ],
    [
      "an empty segment from a doubled slash",
      `${SCHEME}://artifact-myart123--${MOUNT}//foo`,
    ],
    ["malformed percent-encoding", `${SCHEME}://artifact-myart123--${MOUNT}/%`],
    [
      "an uppercase artifact id",
      `${SCHEME}://artifact-MyArt123--${MOUNT}/x`,
    ],
    [
      "an uppercase mount id",
      `${SCHEME}://artifact-myart123--ABCDEF/x`,
    ],
    ["a missing artifact- prefix", `${SCHEME}://myart123--${MOUNT}/x`],
    ["no -- delimiter at all", `${SCHEME}://artifact-onlyonepiece/x`],
    [
      "an empty artifact id before the delimiter",
      `${SCHEME}://artifact---${MOUNT}/x`,
    ],
    ["an empty mount id after the delimiter", `${SCHEME}://artifact-myart123--/x`],
    ["not this scheme's shape at all", "not-a-url"],
    ["a totally different scheme shape", "https://example.com/x"],
  ])("refuses %s", (_label, url) => {
    expect(parseArtifactAddress(url)).toBeNull();
  });

  it("splits the host at the LAST -- so a hyphenated artifact id round-trips", () => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "foo--bar", mountId: MOUNT, treePath: "", path: "x.txt" });
    expect(parseArtifactAddress(url)).toEqual({
      artifactId: "foo--bar",
      mountId: MOUNT,
      path: "x.txt",
    });
  });

  it("recovers an artifact id ending in a hyphen right before the delimiter", () => {
    // Host reads "artifact-foo---<mount>": three hyphens in a row. Only the
    // LAST "--" can be the delimiter, because the mount id itself never
    // contains a hyphen, so greedily picking it from the right is the only
    // split that leaves a well-formed mount id.
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "foo-", mountId: MOUNT, treePath: "", path: "x.txt" });
    expect(parseArtifactAddress(url)).toEqual({
      artifactId: "foo-",
      mountId: MOUNT,
      path: "x.txt",
    });
  });
});

describe("buildArtifactAddress", () => {
  it("accepts a scheme with or without a trailing colon, identically", () => {
    const withColon = buildArtifactAddress({ scheme: `${SCHEME}:`, artifactId: "myart123", mountId: MOUNT, treePath: "", path: "x" });
    const withoutColon = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "", path: "x" });
    expect(withColon).toBe(withoutColon);
  });

  it("defaults an empty path to index.html", () => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "", path: "" });
    expect(url.endsWith("/index.html")).toBe(true);
    expect(parseArtifactAddress(url)?.path).toBe("index.html");
  });

  it.each<[string, string, string, string]>([
    ["an uppercase artifact id", "MyArt123", MOUNT, "x"],
    ["an uppercase mount id", "myart123", "ABCDEF", "x"],
  ])("throws instead of lowercasing %s", (_label, artifactId, mountId, path) => {
    expect(() =>
      buildArtifactAddress({ scheme: SCHEME, artifactId: artifactId, mountId: mountId, treePath: "", path: path }),
    ).toThrow();
  });

  it("throws on an invalid scheme rather than coercing it", () => {
    expect(() => buildArtifactAddress({ scheme: "9bad", artifactId: "myart123", mountId: MOUNT, treePath: "", path: "x" })).toThrow();
    expect(() => buildArtifactAddress({ scheme: "has space", artifactId: "myart123", mountId: MOUNT, treePath: "", path: "x" })).toThrow();
  });

  it.each<[string, string]>([
    ["a .. segment", "../secret"],
    ["a leading-dot segment", ".hidden"],
    ["a backslash", "foo\\bar"],
    ["an empty segment", "a//b"],
  ])("throws on %s in the path", (_label, path) => {
    expect(() => buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "", path: path })).toThrow();
  });

  it.each<[string, string]>([
    ["a space", "a file.txt"],
    ["a hash", "a#b"],
    ["a question mark", "a?b"],
    ["unicode", "café.txt"],
  ])("round-trips a path that needs percent-encoding: %s", (_label, path) => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "", path: path });
    expect(parseArtifactAddress(url)).toEqual({
      artifactId: "myart123",
      mountId: MOUNT,
      path,
    });
  });
});

describe("buildArtifactAddress — tree paths", () => {
  it("joins a non-empty tree path in front of the artifact-relative path", () => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "parent/report", path: "index.html" });
    expect(parseArtifactAddress(url)).toEqual({
      artifactId: "myart123",
      mountId: MOUNT,
      path: "parent/report/index.html",
    });
  });

  it("defaults an empty path to index.html even under a non-empty tree path", () => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "parent/report", path: "" });
    expect(url.endsWith("/parent/report/index.html")).toBe(true);
    expect(parseArtifactAddress(url)?.path).toBe("parent/report/index.html");
  });

  it.each<[string, string]>([
    ["a .. segment", "../escape"],
    ["a leading-dot segment", ".hidden"],
    ["a backslash", "foo\\bar"],
    ["an empty segment", "a//b"],
  ])("throws on %s in the tree path", (_label, treePath) => {
    expect(() => buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: treePath, path: "x" })).toThrow();
  });

  it("resolves a sibling tree path via ordinary relative URL resolution", () => {
    const entryUrl = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: MOUNT, treePath: "parent/report", path: "index.html" });
    const siblingUrl = new URL("../other/clip.mp4", entryUrl).href;
    expect(parseArtifactAddress(siblingUrl)).toEqual({
      artifactId: "myart123",
      mountId: MOUNT,
      path: "parent/other/clip.mp4",
    });
  });
});

describe("newMountId", () => {
  it("returns a lowercase alphanumeric id of at least 16 characters", () => {
    const id = newMountId();
    expect(id.length).toBeGreaterThanOrEqual(16);
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("is usable directly as a valid mount id", () => {
    const url = buildArtifactAddress({ scheme: SCHEME, artifactId: "myart123", mountId: newMountId(), treePath: "", path: "x" });
    expect(parseArtifactAddress(url)).not.toBeNull();
  });

  it("returns a different id on each call", () => {
    expect(newMountId()).not.toBe(newMountId());
  });
});
