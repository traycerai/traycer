/**
 * The host archive, its signature, the descriptor, and the descriptor
 * signature sit beside the CLI binary. The packaged relative path is
 * `cli/<platform>-<arch>/<archive name>` through the existing extraResources
 * mapping. `resources/host` stays the placeholder.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledHostArchiveNames } from "../../../traycer-cli/src/installer/bundled-host";

const require = createRequire(import.meta.url);
const {
  bundledHostSiblingNames,
} = require("../prepack/check-cli-resource.cjs");

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SHIPPED: ReadonlyArray<readonly [string, string]> = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
];

describe("bundled host layout beside the CLI", () => {
  it.each(SHIPPED)(
    "stages %s-%s beside the CLI under the names the CLI resolves",
    (platform, arch) => {
      const archives = bundledHostArchiveNames(
        platform as NodeJS.Platform,
        arch,
      );
      const siblings = bundledHostSiblingNames(platform, arch);
      expect(siblings.archives).toEqual(archives);
      expect(siblings.platformKey).toBe(`${platform}-${arch}`);
      const stagedArchives =
        platform === "win32"
          ? [
              `cli/${platform}-${arch}/host-runtime-${platform}-${arch}.tar.gz`,
              `cli/${platform}-${arch}/host-runtime-${platform}-${arch}.zip`,
            ]
          : [`cli/${platform}-${arch}/host-runtime-${platform}-${arch}.tar.gz`];
      expect(
        archives.map((archive) => `cli/${platform}-${arch}/${archive}`),
      ).toEqual(stagedArchives);
      expect(`cli/${platform}-${arch}/${siblings.descriptor}`).toBe(
        `cli/${platform}-${arch}/host-runtime-${platform}-${arch}.descriptor.json`,
      );
    },
  );

  it("resolves a Windows arm64 host filename to x64, tar.gz then zip", () => {
    expect(bundledHostArchiveNames("win32", "arm64")).toEqual([
      "host-runtime-win32-x64.tar.gz",
      "host-runtime-win32-x64.zip",
    ]);
    expect(bundledHostSiblingNames("win32", "arm64").archives).toEqual(
      bundledHostArchiveNames("win32", "arm64"),
    );
    expect(bundledHostSiblingNames("win32", "arm64").platformKey).toBe(
      "win32-x64",
    );
  });

  it("keeps the desktop --bundled candidate order on the CLI's Windows order", () => {
    const controller = readFileSync(
      path.join(
        DESKTOP_ROOT,
        "src",
        "electron-main",
        "host",
        "host-controller.ts",
      ),
      "utf8",
    );
    const tar = controller.indexOf("`host-runtime-win32-${arch}.tar.gz`");
    const zip = controller.indexOf("`host-runtime-win32-${arch}.zip`");
    expect(tar).toBeGreaterThan(0);
    expect(zip).toBeGreaterThan(tar);
    expect(controller).toContain(
      'const arch = process.arch === "arm64" ? "x64" : process.arch;',
    );
  });

  it("ships the four siblings through the existing CLI extraResources filter", () => {
    const parsed: {
      build: {
        extraResources: Array<{ from: string; to: string; filter: string[] }>;
        mac: { extraResources: Array<{ filter: string[] }> };
        win: { extraResources: Array<{ filter: string[] }> };
        linux: { extraResources: Array<{ filter: string[] }> };
      };
    } = JSON.parse(
      readFileSync(path.join(DESKTOP_ROOT, "package.json"), "utf8"),
    );
    const placeholder = parsed.build.extraResources.find(
      (entry) => entry.to === "host",
    );
    expect(placeholder?.from).toBe("resources/host");
    expect([...(placeholder?.filter ?? [])].sort()).toEqual(
      [".gitkeep", "README.md"].sort(),
    );
    for (const section of [
      parsed.build.mac,
      parsed.build.win,
      parsed.build.linux,
    ]) {
      expect(section.extraResources).toHaveLength(1);
      expect(section.extraResources[0]?.filter).toEqual(["**/*"]);
    }
  });
});
