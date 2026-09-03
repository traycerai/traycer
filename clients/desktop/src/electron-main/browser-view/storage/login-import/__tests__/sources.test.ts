import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeCookieFileSource,
  discoverLoginImportSources,
  normalizePickedFilePath,
  parseFirefoxProfilesIni,
  type LoginImportDiscoveryEnvironment,
} from "../sources";

/**
 * Every fixture tree lives under a fresh temp dir per test, and every mtime
 * is set explicitly with `utimes` - the ordering assertions would be a coin
 * flip against wall-clock write speed otherwise.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "login-import-sources-"));
});

afterEach(async () => {
  // A test that chmods a directory to 0 has to restore access before rm can
  // walk back into it to delete it.
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function writeFileAt(
  path: string,
  content: string,
  mtimeMs: number,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
}

function environment(
  overrides: Partial<LoginImportDiscoveryEnvironment>,
): LoginImportDiscoveryEnvironment {
  return {
    platform: "darwin",
    homeDir: root,
    env: {},
    ...overrides,
  };
}

const T1 = new Date("2026-01-01T00:00:00.000Z").getTime();
const T2 = new Date("2026-02-01T00:00:00.000Z").getTime();
const T3 = new Date("2026-03-01T00:00:00.000Z").getTime();

describe("discoverLoginImportSources: chromium", () => {
  it("prefers Network/Cookies over Cookies when it is the newer jar", async () => {
    const profileDir = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
    );
    await writeFileAt(join(profileDir, "Cookies"), "old", T1);
    await writeFileAt(join(profileDir, "Network", "Cookies"), "new", T2);

    const sources = await discoverLoginImportSources(environment({}));
    const chrome = sources.find((source) => source.browser === "chrome");

    expect(chrome).toBeDefined();
    expect(chrome?.lastUsedAt).toBe(T2);
    expect(chrome?.location).toEqual({
      kind: "chromium",
      browser: "chrome",
      cookiesPath: join(profileDir, "Network", "Cookies"),
      localStatePath: join(profileDir, "..", "Local State"),
    });
  });

  it("prefers the root Cookies file when it is newer than Network/Cookies", async () => {
    const profileDir = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
    );
    await writeFileAt(join(profileDir, "Cookies"), "new", T3);
    await writeFileAt(join(profileDir, "Network", "Cookies"), "old", T1);

    const sources = await discoverLoginImportSources(environment({}));
    const chrome = sources.find((source) => source.browser === "chrome");

    expect(chrome?.location.kind).toBe("chromium");
    expect(chrome?.lastUsedAt).toBe(T3);
    if (chrome?.location.kind === "chromium") {
      expect(chrome.location.cookiesPath).toBe(join(profileDir, "Cookies"));
    }
  });

  it("finds Aside and Helium under their macOS Application Support roots", async () => {
    const support = join(root, "Library", "Application Support");
    await writeFileAt(join(support, "Aside", "Default", "Cookies"), "a", T1);
    await writeFileAt(
      join(support, "net.imput.helium", "Default", "Cookies"),
      "h",
      T2,
    );

    const sources = await discoverLoginImportSources(environment({}));
    const aside = sources.find((source) => source.browser === "aside");
    const helium = sources.find((source) => source.browser === "helium");

    expect(aside?.location).toEqual({
      kind: "chromium",
      browser: "aside",
      cookiesPath: join(support, "Aside", "Default", "Cookies"),
      localStatePath: join(support, "Aside", "Local State"),
    });
    expect(helium?.location).toEqual({
      kind: "chromium",
      browser: "helium",
      cookiesPath: join(support, "net.imput.helium", "Default", "Cookies"),
      localStatePath: join(support, "net.imput.helium", "Local State"),
    });
  });

  it("does not look for Aside or Helium on Windows or Linux", async () => {
    // Each platform gets a Chrome jar at its real root, so a run that finds
    // Chrome and not the candidates below proves discovery walked the tree
    // and skipped them, rather than finding nothing at all. The candidate
    // roots are where a Chromium fork conventionally lands on each OS.
    const local = join(root, "AppData", "Local");
    const config = join(root, ".config");
    const candidates: Record<"win32" | "linux", readonly string[]> = {
      win32: [
        join(local, "Google", "Chrome", "User Data"),
        join(local, "Aside", "User Data"),
        join(local, "Aside"),
        join(local, "net.imput.helium", "User Data"),
        join(local, "imput", "Helium", "User Data"),
      ],
      linux: [
        join(config, "google-chrome"),
        join(config, "Aside"),
        join(config, "aside"),
        join(config, "net.imput.helium"),
        join(config, "helium"),
      ],
    };
    for (const platform of ["win32", "linux"] as const) {
      for (const userDataDir of candidates[platform]) {
        await writeFileAt(join(userDataDir, "Default", "Cookies"), "c", T1);
      }

      const sources = await discoverLoginImportSources(
        environment({ platform }),
      );

      expect(sources.some((source) => source.browser === "chrome")).toBe(true);
      expect(
        sources.filter(
          (source) => source.browser === "aside" || source.browser === "helium",
        ),
      ).toEqual([]);
    }
  });

  it("finds Opera's profileless root-level cookie database as 'Default'", async () => {
    const operaRoot = join(
      root,
      "Library",
      "Application Support",
      "com.operasoftware.Opera",
    );
    await writeFileAt(join(operaRoot, "Cookies"), "opera", T1);

    const sources = await discoverLoginImportSources(environment({}));
    const opera = sources.find((source) => source.browser === "opera");

    expect(opera).toBeDefined();
    expect(opera?.profileLabel).toBe("Default");
    expect(opera?.location).toEqual({
      kind: "chromium",
      browser: "opera",
      cookiesPath: join(operaRoot, "Cookies"),
      localStatePath: join(operaRoot, "Local State"),
    });
  });

  it("labels profiles from Local State's info_cache, disambiguating a shared name by directory", async () => {
    const chromeRoot = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    await mkdir(chromeRoot, { recursive: true });
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Work" },
            "Profile 1": { name: "Work" },
            "Profile 2": { name: "Personal" },
          },
        },
      }),
    );
    await mkdir(join(chromeRoot, "Default"), { recursive: true });
    await mkdir(join(chromeRoot, "Profile 1"), { recursive: true });
    await mkdir(join(chromeRoot, "Profile 2"), { recursive: true });
    await writeFileAt(join(chromeRoot, "Default", "Cookies"), "a", T1);
    await writeFileAt(join(chromeRoot, "Profile 1", "Cookies"), "b", T2);
    await writeFileAt(join(chromeRoot, "Profile 2", "Cookies"), "c", T3);

    const sources = await discoverLoginImportSources(environment({}));
    const chromeLabels = sources
      .filter((source) => source.browser === "chrome")
      .map((source) => source.profileLabel)
      .sort();

    expect(chromeLabels).toEqual([
      "Personal",
      "Work (Default)",
      "Work (Profile 1)",
    ]);
  });

  it("falls back to directory-derived labels when Local State cannot be read", async () => {
    const chromeRoot = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    await mkdir(join(chromeRoot, "Default"), { recursive: true });
    await mkdir(join(chromeRoot, "Profile 3"), { recursive: true });
    await mkdir(join(chromeRoot, "Not A Profile"), { recursive: true });
    await writeFileAt(join(chromeRoot, "Default", "Cookies"), "a", T1);
    await writeFileAt(join(chromeRoot, "Profile 3", "Cookies"), "b", T2);
    await writeFileAt(join(chromeRoot, "Not A Profile", "Cookies"), "c", T3);

    const sources = await discoverLoginImportSources(environment({}));
    const chromeLabels = sources
      .filter((source) => source.browser === "chrome")
      .map((source) => source.profileLabel)
      .sort();

    // "Not A Profile" is not `Default` or `Profile N`, so it is excluded from
    // the directory-name fallback even though it holds a jar.
    expect(chromeLabels).toEqual(["Default", "Profile 3"]);
  });

  it("drops an info_cache key that is not a plain directory name", async () => {
    const chromeRoot = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    await mkdir(chromeRoot, { recursive: true });
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Default" },
            "../../elsewhere": { name: "Escape" },
            "Profile 2/../x": { name: "Traversal" },
            "C:\\other": { name: "Backslash" },
            "..": { name: "DotDot" },
            "": { name: "Empty" },
          },
        },
      }),
    );
    await mkdir(join(chromeRoot, "Default"), { recursive: true });
    await writeFileAt(join(chromeRoot, "Default", "Cookies"), "a", T1);
    // The key a pre-fix reader would have joined straight onto the User Data
    // dir, escaping it two levels up. A real jar sits there so the assertion
    // below proves discovery never reached it, not merely that nothing was
    // there to find.
    const traversalTarget = join(
      root,
      "Library",
      "Application Support",
      "elsewhere",
    );
    await writeFileAt(join(traversalTarget, "Cookies"), "escaped", T2);

    const sources = await discoverLoginImportSources(environment({}));
    const chromeSources = sources.filter(
      (source) => source.browser === "chrome",
    );

    expect(chromeSources).toHaveLength(1);
    expect(chromeSources[0]?.profileLabel).toBe("Default");
    for (const source of sources) {
      if (source.location.kind !== "chromium") continue;
      const userDataDir = dirname(source.location.localStatePath);
      expect(source.location.cookiesPath.startsWith(userDataDir + sep)).toBe(
        true,
      );
    }
  });
});

describe("discoverLoginImportSources: firefox", () => {
  it("resolves a relative profile against the Firefox root and an absolute profile as-is", async () => {
    const firefoxRoot = join(root, "Library", "Application Support", "Firefox");
    const relativeProfileDir = join(firefoxRoot, "abc123.default");
    const absoluteProfileRoot = await mkdtemp(
      join(tmpdir(), "login-import-absolute-profile-"),
    );
    const absoluteProfileDir = join(absoluteProfileRoot, "work.profile");

    await writeFileAt(
      join(relativeProfileDir, "cookies.sqlite"),
      "relative",
      T1,
    );
    await writeFileAt(
      join(absoluteProfileDir, "cookies.sqlite"),
      "absolute",
      T2,
    );
    await writeFile(
      join(firefoxRoot, "profiles.ini"),
      [
        "[Profile0]",
        "Name=Default",
        "IsRelative=1",
        "Path=abc123.default",
        "",
        "[Profile1]",
        "Name=Work",
        "IsRelative=0",
        `Path=${absoluteProfileDir}`,
        "",
      ].join("\n"),
    );

    try {
      const sources = await discoverLoginImportSources(environment({}));
      const firefox = sources.filter((source) => source.browser === "firefox");

      expect(firefox).toHaveLength(2);
      const byLabel = new Map(
        firefox.map((source) => [source.profileLabel, source]),
      );
      expect(byLabel.get("Default")?.location).toEqual({
        kind: "firefox",
        cookiesPath: join(relativeProfileDir, "cookies.sqlite"),
      });
      expect(byLabel.get("Work")?.location).toEqual({
        kind: "firefox",
        cookiesPath: join(absoluteProfileDir, "cookies.sqlite"),
      });
    } finally {
      await rm(absoluteProfileRoot, { recursive: true, force: true });
    }
  });

  it("drops a profile whose cookies.sqlite is missing", async () => {
    const firefoxRoot = join(root, "Library", "Application Support", "Firefox");
    await mkdir(firefoxRoot, { recursive: true });
    await writeFile(
      join(firefoxRoot, "profiles.ini"),
      [
        "[Profile0]",
        "Name=Ghost",
        "IsRelative=1",
        "Path=ghost.default",
        "",
      ].join("\n"),
    );

    const sources = await discoverLoginImportSources(environment({}));
    expect(sources.filter((source) => source.browser === "firefox")).toEqual(
      [],
    );
  });
});

describe("discoverLoginImportSources: linux snap/flatpak roots", () => {
  it("discovers Firefox under a snap root and a flatpak root", async () => {
    const snapRoot = join(
      root,
      "snap",
      "firefox",
      "common",
      ".mozilla",
      "firefox",
    );
    const flatpakRoot = join(
      root,
      ".var",
      "app",
      "org.mozilla.firefox",
      ".mozilla",
      "firefox",
    );
    await writeFileAt(
      join(snapRoot, "snap-profile", "cookies.sqlite"),
      "s",
      T1,
    );
    await writeFile(
      join(snapRoot, "profiles.ini"),
      ["[Profile0]", "Name=Snap", "IsRelative=1", "Path=snap-profile", ""].join(
        "\n",
      ),
    );
    await writeFileAt(
      join(flatpakRoot, "flatpak-profile", "cookies.sqlite"),
      "f",
      T1,
    );
    await writeFile(
      join(flatpakRoot, "profiles.ini"),
      [
        "[Profile0]",
        "Name=Flatpak",
        "IsRelative=1",
        "Path=flatpak-profile",
        "",
      ].join("\n"),
    );

    const sources = await discoverLoginImportSources(
      environment({ platform: "linux", env: {} }),
    );
    const labels = sources
      .filter((source) => source.browser === "firefox")
      .map((source) => source.profileLabel)
      .sort();

    // The install flavour is appended to the profile's own label - "Flatpak"
    // becomes "Flatpak (Flatpak)" and "Snap" becomes "Snap (Snap)" - so a
    // shared profile name from two install kinds still disambiguates.
    expect(labels).toEqual(["Flatpak (Flatpak)", "Snap (Snap)"]);
  });

  it("discovers Chromium under a snap root and Brave under a flatpak root", async () => {
    const snapChromiumRoot = join(
      root,
      "snap",
      "chromium",
      "common",
      "chromium",
    );
    const flatpakBraveRoot = join(
      root,
      ".var",
      "app",
      "com.brave.Browser",
      "config",
      "BraveSoftware",
      "Brave-Browser",
    );
    await writeFileAt(join(snapChromiumRoot, "Default", "Cookies"), "c", T1);
    await writeFileAt(join(flatpakBraveRoot, "Default", "Cookies"), "b", T1);

    const sources = await discoverLoginImportSources(
      environment({ platform: "linux", env: {} }),
    );

    expect(sources.some((source) => source.browser === "chromium")).toBe(true);
    expect(sources.some((source) => source.browser === "brave")).toBe(true);
  });
});

describe("discoverLoginImportSources: safari", () => {
  it("is discovered on darwin from the sandboxed container path", async () => {
    await writeFileAt(
      join(
        root,
        "Library",
        "Containers",
        "com.apple.Safari",
        "Data",
        "Library",
        "Cookies",
        "Cookies.binarycookies",
      ),
      "safari",
      T1,
    );

    const sources = await discoverLoginImportSources(environment({}));
    const safari = sources.find((source) => source.browser === "safari");

    expect(safari).toBeDefined();
    expect(safari?.profileLabel).toBe("Safari");
  });

  it("is absent on win32 and linux even when the darwin-shaped path exists", async () => {
    await writeFileAt(
      join(
        root,
        "Library",
        "Containers",
        "com.apple.Safari",
        "Data",
        "Library",
        "Cookies",
        "Cookies.binarycookies",
      ),
      "safari",
      T1,
    );

    const win32Sources = await discoverLoginImportSources(
      environment({ platform: "win32", env: {} }),
    );
    const linuxSources = await discoverLoginImportSources(
      environment({ platform: "linux", env: {} }),
    );

    expect(win32Sources.some((source) => source.browser === "safari")).toBe(
      false,
    );
    expect(linuxSources.some((source) => source.browser === "safari")).toBe(
      false,
    );
  });

  it("is still listed, with a null lastUsedAt, when the container answers permission-denied", async () => {
    if (process.platform === "win32") return;
    const cookiesDir = join(
      root,
      "Library",
      "Containers",
      "com.apple.Safari",
      "Data",
      "Library",
      "Cookies",
    );
    await writeFileAt(join(cookiesDir, "Cookies.binarycookies"), "safari", T1);
    // Stripping the parent directory's execute bit makes traversal into it
    // fail with EACCES, the same errno a locked-down TCC container answers
    // with - without needing Full Disk Access in CI.
    await chmod(cookiesDir, 0o000);

    try {
      const sources = await discoverLoginImportSources(environment({}));
      const safari = sources.find((source) => source.browser === "safari");

      if (process.getuid !== undefined && process.getuid() === 0) {
        // Root ignores the permission bit entirely; the assertion below would
        // be testing the sandbox, not the code, so skip it under root.
        return;
      }
      expect(safari).toBeDefined();
      expect(safari?.lastUsedAt).toBeNull();
    } finally {
      await chmod(cookiesDir, 0o755);
    }
  });
});

describe("discoverLoginImportSources: ordering", () => {
  it("sorts by last-used descending, with a null lastUsedAt last", async () => {
    if (process.platform === "win32") return;
    const chromeProfileDir = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
    );
    const firefoxRoot = join(root, "Library", "Application Support", "Firefox");
    await writeFileAt(join(chromeProfileDir, "Cookies"), "c", T2);
    await writeFileAt(
      join(firefoxRoot, "default.profile", "cookies.sqlite"),
      "f",
      T3,
    );
    await writeFile(
      join(firefoxRoot, "profiles.ini"),
      [
        "[Profile0]",
        "Name=Default",
        "IsRelative=1",
        "Path=default.profile",
        "",
      ].join("\n"),
    );
    const cookiesDir = join(
      root,
      "Library",
      "Containers",
      "com.apple.Safari",
      "Data",
      "Library",
      "Cookies",
    );
    await writeFileAt(join(cookiesDir, "Cookies.binarycookies"), "s", T1);
    await chmod(cookiesDir, 0o000);

    try {
      const sources = await discoverLoginImportSources(environment({}));
      if (process.getuid !== undefined && process.getuid() === 0) return;

      // Firefox (T3) newest, then Chrome (T2), then Safari last because its
      // lastUsedAt is null (permission-denied) and null always sorts last.
      expect(sources.map((source) => source.browser)).toEqual([
        "firefox",
        "chrome",
        "safari",
      ]);
      expect(sources[sources.length - 1]?.lastUsedAt).toBeNull();
    } finally {
      await chmod(cookiesDir, 0o755);
    }
  });
});

describe("parseFirefoxProfilesIni", () => {
  it("parses Profile sections and skips General/Install sections", () => {
    const ini = [
      "[General]",
      "StartWithLastProfile=1",
      "",
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=xyz.default-release",
      "Default=1",
      "",
      "[Install1234]",
      "Default=xyz.default-release",
      "Locked=1",
      "",
    ].join("\n");

    const profiles = parseFirefoxProfilesIni(ini);

    expect(profiles).toEqual([
      {
        name: "default-release",
        path: "xyz.default-release",
        isRelative: true,
      },
    ]);
  });

  it("falls back to the last path segment as the name when Name is missing", () => {
    const ini = [
      "[Profile0]",
      "IsRelative=1",
      "Path=some/nested/nameless.default",
      "",
    ].join("\n");

    expect(parseFirefoxProfilesIni(ini)).toEqual([
      {
        name: "nameless.default",
        path: "some/nested/nameless.default",
        isRelative: true,
      },
    ]);
  });

  it("falls back to the last path segment when Name is present but empty", () => {
    const ini = [
      "[Profile0]",
      "Name=",
      "IsRelative=1",
      "Path=abcd1234.default-release",
      "",
    ].join("\n");

    expect(parseFirefoxProfilesIni(ini)).toEqual([
      {
        name: "abcd1234.default-release",
        path: "abcd1234.default-release",
        isRelative: true,
      },
    ]);
  });

  it("falls back to the last segment of an absolute POSIX path when Name is missing", () => {
    const ini = [
      "[Profile0]",
      "IsRelative=0",
      "Path=/Users/someone/Library/Application Support/Firefox/Profiles/abcd.default",
      "",
    ].join("\n");

    expect(parseFirefoxProfilesIni(ini)).toEqual([
      {
        name: "abcd.default",
        path: "/Users/someone/Library/Application Support/Firefox/Profiles/abcd.default",
        isRelative: false,
      },
    ]);
  });

  it("falls back to the last segment of a Windows-style absolute path when Name is missing", () => {
    const ini = [
      "[Profile0]",
      "IsRelative=0",
      "Path=C:\\Users\\someone\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abcd.default",
      "",
    ].join("\n");

    expect(parseFirefoxProfilesIni(ini)).toEqual([
      {
        name: "abcd.default",
        path: "C:\\Users\\someone\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abcd.default",
        isRelative: false,
      },
    ]);
  });

  it("drops a Profile section with no Path", () => {
    const ini = ["[Profile0]", "Name=Incomplete", "IsRelative=1", ""].join(
      "\n",
    );

    expect(parseFirefoxProfilesIni(ini)).toEqual([]);
  });

  it("treats IsRelative=0 as absolute and any other value as relative", () => {
    const ini = [
      "[Profile0]",
      "Name=Abs",
      "IsRelative=0",
      "Path=/abs/path",
      "",
      "[Profile1]",
      "Name=Rel",
      "IsRelative=2",
      "Path=rel/path",
      "",
    ].join("\n");

    expect(parseFirefoxProfilesIni(ini)).toEqual([
      { name: "Abs", path: "/abs/path", isRelative: false },
      { name: "Rel", path: "rel/path", isRelative: true },
    ]);
  });
});

describe("describeCookieFileSource", () => {
  it("describes a picked file by its basename and mtime", async () => {
    const path = join(root, "exported-cookies.txt");
    await writeFileAt(path, "cookie text", T2);

    const source = await describeCookieFileSource(path);

    expect(source).toEqual({
      browser: "file",
      profileLabel: "exported-cookies.txt",
      lastUsedAt: T2,
      location: { kind: "file", path },
    });
  });

  it("returns a null lastUsedAt when the file cannot be stat'd", async () => {
    const path = join(root, "does-not-exist.txt");

    const source = await describeCookieFileSource(path);

    expect(source.lastUsedAt).toBeNull();
  });
});

describe("normalizePickedFilePath", () => {
  it("rejects a relative path", () => {
    expect(normalizePickedFilePath("relative/cookies.txt")).toBeNull();
  });

  it("resolves an absolute path with redundant segments", () => {
    // Built with sep.join rather than join(): join() collapses ".." and "."
    // itself, which would make this test pass even if
    // normalizePickedFilePath did no normalisation of its own.
    const messy = [root, "a", "..", "b", ".", "cookies.txt"].join(sep);
    expect(messy).not.toBe(join(root, "b", "cookies.txt"));
    expect(normalizePickedFilePath(messy)).toBe(join(root, "b", "cookies.txt"));
  });
});
