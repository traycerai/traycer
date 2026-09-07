import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findFile,
  parseUpdateInfo,
} from "electron-updater/out/providers/Provider";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper";
import type { ResolvedUpdateFileInfo } from "electron-updater/out/types";

/** Vendored-source contracts at the pinned electron-updater. */

const DESKTOP_PACKAGE_NAME = "@traycer-clients/desktop";

function findDesktopPackageJson(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of [
      join(dir, "package.json"),
      join(dir, "clients", "desktop", "package.json"),
    ]) {
      if (!existsSync(candidate)) continue;
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (readStringField(parsed, "name") === DESKTOP_PACKAGE_NAME) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate ${DESKTOP_PACKAGE_NAME}'s package.json from ${process.cwd()}`,
  );
}

function findUpdaterInstallRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "node_modules", "electron-updater", "out"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "could not locate node_modules/electron-updater from " + process.cwd(),
  );
}

const UPDATER_OUT = join(
  findUpdaterInstallRoot(),
  "node_modules",
  "electron-updater",
  "out",
);
const DESKTOP_PACKAGE_JSON = findDesktopPackageJson();

function readOut(rel: string): string {
  return readFileSync(join(UPDATER_OUT, rel), "utf8");
}

/** One narrowing step from `unknown`, shared by the JSON readers below. */
function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const record: Record<string, unknown> = { ...value };
  return record[key];
}

function readStringField(value: unknown, key: string): string | null {
  const field = readField(value, key);
  return typeof field === "string" ? field : null;
}

/** Returns the raw value so the test can assert its TYPE, which a coercing reader would hide. */
function customKey(value: object): unknown {
  const record: Record<string, unknown> = { ...value };
  return record["compatibilityEpoch"];
}

describe("electron-updater 6.8.9 vendored contracts", () => {
  it("pins the dependency this suite is describing", () => {
    const pkg: unknown = JSON.parse(readFileSync(DESKTOP_PACKAGE_JSON, "utf8"));
    expect(
      readStringField(readField(pkg, "dependencies"), "electron-updater"),
    ).toBe("^6.8.9");
  });

  it("BaseUpdater re-reads autoInstallOnAppQuit INSIDE the registered quit callback", () => {
    const source = readOut("BaseUpdater.js");
    const start = source.indexOf("addQuitHandler() {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n    }", start));

    const gate = body.indexOf(
      "if (this.quitHandlerAdded || !this.autoInstallOnAppQuit)",
    );
    const registration = body.indexOf("this.app.onQuit(");
    const reread = body.indexOf("if (!this.autoInstallOnAppQuit)");

    // Registration gate first, then the callback is registered, then the
    // re-read lives inside that callback.
    expect(gate).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(gate);
    expect(reread).toBeGreaterThan(registration);
    expect(body).toContain(
      "Update will not be installed on quit because autoInstallOnAppQuit is set to false.",
    );
  });

  it("parseUpdateInfo really preserves compatibilityEpoch, and the emit spread carries it", () => {
    // EXECUTED, not text-matched. This is the hop the whole epoch design rests
    // on: a key we add to `latest*.yml` has to survive electron-updater's own
    // parse and reach `update-available` / `update-downloaded` intact.
    const parsed = parseUpdateInfo(
      [
        "version: 1.2.0",
        "compatibilityEpoch: 2",
        "files:",
        "  - url: Traycer-1.2.0.exe",
        "    sha512: abc",
        "path: Traycer-1.2.0.exe",
        "sha512: abc",
        "releaseDate: '2026-01-01T00:00:00.000Z'",
      ].join("\n"),
      "latest.yml",
      new URL("https://example.invalid/latest.yml"),
    );

    expect(parsed.version).toBe("1.2.0");
    expect(customKey(parsed)).toBe(2);

    const emitted = { ...parsed, downloadedFile: "/tmp/Traycer-1.2.0.exe" };
    expect(customKey(emitted)).toBe(2);
    expect(emitted.downloadedFile).toBe("/tmp/Traycer-1.2.0.exe");

    // And the value keeps its NUMBER type through the hop - a string "2" would
    // read as `null` at `readCompatibilityEpoch` and route every user to the
    // manual link.
    expect(typeof customKey(emitted)).toBe("number");
  });

  it("DownloadedUpdateHelper empties pending/ when the cached sha512 does not match", async () => {
    // This is what dissolves the "a staged artifact could be reused by a later download" half of the old blanket channel-change refusal: an RC candidate never matches a stable.
    const cacheDir = mkdtempSync(join(tmpdir(), "traycer-updater-cache-"));
    const helper = new DownloadedUpdateHelper(cacheDir);
    const probe = helper["getValidCachedUpdateFile"].bind(helper);
    const pending = helper.cacheDirForPendingUpdate;
    mkdirSync(pending, { recursive: true });

    const artifact = join(pending, "Traycer-1.1.11.exe");
    writeFileSync(artifact, "stale stable artifact bytes");
    const staleSha = createHash("sha512")
      .update(readFileSync(artifact))
      .digest("base64");
    writeFileSync(
      join(pending, "update-info.json"),
      JSON.stringify({ fileName: "Traycer-1.1.11.exe", sha512: staleSha }),
    );

    const logger = { info: () => undefined, warn: () => undefined };

    // Matching hash: the cached file is offered back, so the fixture is
    // genuinely valid and the mismatch below is the only variable.
    await expect(
      probe(
        { info: { sha512: staleSha }, url: new URL("https://x.invalid/a") },
        logger,
      ),
    ).resolves.toBe(artifact);
    expect(existsSync(artifact)).toBe(true);

    // A DIFFERENT candidate's hash - what an RC build after a stable one looks
    // like. The helper must refuse it and empty the directory.
    await expect(
      probe(
        {
          info: { sha512: "a-different-candidates-checksum" },
          url: new URL("https://x.invalid/b"),
        },
        logger,
      ),
    ).resolves.toBeNull();
    expect(existsSync(artifact)).toBe(false);

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("MacUpdater hands the artifact to Squirrel.Mac under autoInstallOnAppQuit", () => {
    // install-then-recheck and the standing macOS refusal are the only honest
    // options because this call has already natively staged the update.
    const source = readOut("MacUpdater.js");
    expect(source).toContain("if (this.autoInstallOnAppQuit)");
    expect(source).toContain("this.nativeUpdater.checkForUpdates()");
  });

  it("parseUpdateInfo returns the whole js-yaml document, with no key projection", () => {
    // Custom-key survival: `compatibilityEpoch` stamped on the channel file
    // reaches the updater only because this is a bare load.
    const source = readOut("providers/Provider.js");
    expect(source).toContain(
      "function parseUpdateInfo(rawData, channelFile, channelFileUrl)",
    );
    expect(source).toContain("result = (0, js_yaml_1.load)(rawData);");
    expect(source).toContain("return result;");
    expect(source).not.toMatch(/return \{[^}]*version:/u);
  });

  // EXECUTED against the real `findFile`, not text-matched, and asserted in both directions so the fix is pinned alongside the bug.
  describe("findFile resolves the installer by pathname extension", () => {
    // The exact arguments `_DebUpdater.doDownloadUpdate` passes.
    function pickDeb(
      files: ResolvedUpdateFileInfo[],
    ): ResolvedUpdateFileInfo | null | undefined {
      return findFile(files, "deb", ["AppImage", "rpm", "pacman"]);
    }

    const LINUX_ARTIFACTS = [
      "traycer-desktop-linux-x86_64.AppImage",
      "traycer-desktop-linux-x86_64.deb",
    ] as const;

    // The manifest half (`info.url`) is identical in both cases; only the
    // resolved `url` differs, which is exactly the difference the token makes.
    function filesAt(
      urlFor: (name: string, index: number) => string,
    ): ResolvedUpdateFileInfo[] {
      return LINUX_ARTIFACTS.map((name, index) => ({
        url: new URL(urlFor(name, index)),
        info: { url: name, sha512: "abc" },
      }));
    }

    it("falls through to files[0] when the URLs are asset-API ids", () => {
      // The private/authenticated shape: an opaque id, no filename anywhere in
      // the pathname.
      const files = filesAt(
        (_name, index) =>
          `https://api.github.com/repos/traycerai/traycer/releases/assets/${index + 1}`,
      );

      const picked = pickDeb(files);

      // Not the `.deb` that was asked for - the AppImage, purely because it is
      // listed first.
      expect(picked?.info.url).toBe("traycer-desktop-linux-x86_64.AppImage");
    });

    it("picks the .deb once the URLs are browser-download URLs", () => {
      const files = filesAt(
        (name) =>
          `https://github.com/traycerai/traycer/releases/download/desktop-v1.2.0/${name}`,
      );

      const picked = pickDeb(files);

      expect(picked?.info.url).toBe("traycer-desktop-linux-x86_64.deb");
    });
  });
});
