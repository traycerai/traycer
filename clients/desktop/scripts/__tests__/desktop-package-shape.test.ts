/**
 * Static guard against Desktop package-shape regressions tied to the
 * native-packaging cleanup (see ticket
 * f613895a-bdb0-4a95-b1e6-b974ee7dafa0).
 *
 * Pins the `electron-builder` `extraResources` declarations in
 * `clients/desktop/package.json` so:
 *
 *   - Desktop **does not** stage `../../traycer-host/resources` (or
 *     anything else) under `host/client-assets`. Host-side client
 *     assets travel with the native host SEA / runtime archive cut
 *     by the host release workflows, not Desktop.
 *   - Desktop **does not** reintroduce a bundled host executable, a
 *     host runtime, a developer Node binary, a host wrapper, or a
 *     service plist via `extraResources`.
 *   - The `resources/host` placeholder entry stays restricted to
 *     `.gitkeep` + `README.md` so the package shape matches RELEASE.md
 *     / AGENTS.md.
 *
 * The test reads the JSON directly (not the workflow YAMLs) so a hand
 * edit to `package.json` is gated independently of CI workflow drift.
 */
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

/**
 * Every `extraResources` entry electron-builder will evaluate for a given
 * platform: the top-level list plus that platform's own list (app-builder-lib
 * `getFileMatchers` concatenates the two - platform entries ADD to the
 * top-level ones, they do not replace them).
 */
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

  // The bundled CLI is the only host-lifecycle bridge Desktop ships, and it
  // is staged PER TARGET ARCH. A single arch-blind `resources/cli` -> `cli`
  // mapping copies every staged `<platform>-<arch>/` dir into every app, and
  // the macOS release job stages arm64 AND x64 before one `electron-builder
  // --mac` builds both apps - so the arm64 bundle shipped an x86_64-only
  // Mach-O and macOS 26 flagged it as an Intel app (traycerai/traycer#1528).
  // electron-builder's `${arch}` file macro is the supported way to scope a
  // resource to the arch being packed; the platform prefix has to be literal
  // per platform because `${os}` expands to `mac`/`win`/`linux`, not the
  // `process.platform` value the runtime discovery layer keys on.
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
      // The runtime resolves `<resourcesPath>/cli/<platform>-<arch>/<binary>`
      // (cli-discovery.ts) and the macOS afterPack hook copies
      // `cli/darwin-<arch>/traycer` into the helper app - the `to` must keep
      // that exact shape, not flatten to `cli/`.
      expect(entry.to).not.toBe("cli");
    },
  );

  it("embeds the Windows app icon for Start menu and desktop shortcuts", () => {
    expect(pkg.winIcon).toBe("icon.ico");
  });
});
