/** Pin `electron-builder` `extraResources`: no host assets, no bundled host, `resources/host` is `.gitkeep`+README. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const DESKTOP_PACKAGE_JSON = path.join(
  REPO_ROOT,
  "clients",
  "desktop",
  "package.json",
);

interface ExtraResourceEntry {
  readonly from: string;
  readonly to: string;
  readonly filter: ReadonlyArray<string>;
}

interface PlatformExtraResources {
  readonly mac: ReadonlyArray<ExtraResourceEntry>;
  readonly win: ReadonlyArray<ExtraResourceEntry>;
  readonly linux: ReadonlyArray<ExtraResourceEntry>;
}

interface ParsedDesktopPackage {
  readonly extraResources: ReadonlyArray<ExtraResourceEntry>;
  readonly platformExtraResources: PlatformExtraResources;
  readonly winIcon: string | undefined;
}

interface PlatformBuildSection {
  readonly icon?: string;
  readonly extraResources?: ReadonlyArray<ExtraResourceEntry>;
}

function readDesktopPackage(): ParsedDesktopPackage {
  const raw = readFileSync(DESKTOP_PACKAGE_JSON, "utf8");
  const parsed: {
    build?: {
      extraResources?: ReadonlyArray<ExtraResourceEntry>;
      mac?: PlatformBuildSection;
      win?: PlatformBuildSection;
      linux?: PlatformBuildSection;
    };
  } = JSON.parse(raw);
  const extraResources = parsed.build?.extraResources ?? [];
  return {
    extraResources,
    platformExtraResources: {
      mac: parsed.build?.mac?.extraResources ?? [],
      win: parsed.build?.win?.extraResources ?? [],
      linux: parsed.build?.linux?.extraResources ?? [],
    },
    winIcon: parsed.build?.win?.icon,
  };
}

function allExtraResourcesFor(
  pkg: ParsedDesktopPackage,
  platform: keyof PlatformExtraResources,
): ReadonlyArray<ExtraResourceEntry> {
  return [...pkg.extraResources, ...pkg.platformExtraResources[platform]];
}

describe("desktop package.json - extraResources shape", () => {
  const pkg = readDesktopPackage();

  it("does not stage anything under host/client-assets", () => {
    const offenders = pkg.extraResources.filter(
      (entry) => entry.to === "host/client-assets",
    );
    expect(offenders).toEqual([]);
  });

  it("does not stage any sibling under the host/ namespace beyond the placeholder entry", () => {
    // Permitted: { to: "host", filter: ["README.md", ".gitkeep"] }
    // Forbidden: anything that nests under host/<something-else>
    const hostNamespaceEntries = pkg.extraResources.filter(
      (entry) => entry.to === "host" || entry.to.startsWith("host/"),
    );
    expect(hostNamespaceEntries).toHaveLength(1);
    const placeholder = hostNamespaceEntries[0];
    expect(placeholder.to).toBe("host");
    expect(placeholder.from).toBe("resources/host");
    expect([...placeholder.filter].sort()).toEqual(
      [".gitkeep", "README.md"].sort(),
    );
  });

  it("does not pull from the traycer-host source tree at all", () => {
    const fromTraycerHost = pkg.extraResources.filter((entry) =>
      entry.from.includes("traycer-host"),
    );
    expect(fromTraycerHost).toEqual([]);
  });

  it("does not reintroduce a bundled host executable, runtime, dev Node binary, host wrapper, or service plist", () => {
    const forbiddenSources = [
      /traycer-host\/dist/,
      /traycer-host\/sea/,
      /traycer-host\/runtime/,
      /traycer-host\/.*\/(node|bun)$/,
      /host-wrapper/i,
      /\.plist$/,
    ];
    for (const entry of pkg.extraResources) {
      for (const pattern of forbiddenSources) {
        expect(
          entry.from,
          `extraResources entry from='${entry.from}' to='${entry.to}' matched forbidden pattern ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  const CLI_PLATFORM_PREFIX: Record<keyof PlatformExtraResources, string> = {
    mac: "darwin",
    win: "win32",
    linux: "linux",
  };

  it("does not map resources/cli arch-blind at the top level", () => {
    const archBlind = pkg.extraResources.filter(
      (entry) =>
        entry.to === "cli" ||
        entry.to.startsWith("cli/") ||
        entry.from === "resources/cli" ||
        entry.from.startsWith("resources/cli/"),
    );
    expect(archBlind).toEqual([]);
  });

  it.each(["mac", "win", "linux"] as const)(
    "stages exactly the %s target arch's CLI via the ${arch} macro",
    (platform) => {
      const prefix = CLI_PLATFORM_PREFIX[platform];
      const cliEntries = allExtraResourcesFor(pkg, platform).filter(
        (entry) => entry.to === "cli" || entry.to.startsWith("cli/"),
      );
      expect(cliEntries).toHaveLength(1);
      const entry = cliEntries[0];
      expect(entry.from).toBe(`resources/cli/${prefix}-\${arch}`);
      expect(entry.to).toBe(`cli/${prefix}-\${arch}`);
      expect(entry.to).not.toBe("cli");
    },
  );

  it("embeds the Windows app icon for Start menu and desktop shortcuts", () => {
    expect(pkg.winIcon).toBe("icon.ico");
  });
});
