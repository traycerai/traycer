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

interface ParsedDesktopPackage {
  readonly extraResources: ReadonlyArray<ExtraResourceEntry>;
  readonly winIcon: string | undefined;
}

function readDesktopPackage(): ParsedDesktopPackage {
  const raw = readFileSync(DESKTOP_PACKAGE_JSON, "utf8");
  const parsed: {
    build?: {
      extraResources?: ReadonlyArray<ExtraResourceEntry>;
      win?: { icon?: string };
    };
  } = JSON.parse(raw);
  const extraResources = parsed.build?.extraResources ?? [];
  return { extraResources, winIcon: parsed.build?.win?.icon };
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

  it("keeps the bundled CLI staging (the only host-lifecycle bridge Desktop ships)", () => {
    const cliEntry = pkg.extraResources.find((entry) => entry.to === "cli");
    expect(cliEntry).toBeTruthy();
    expect(cliEntry?.from).toBe("resources/cli");
  });

  it("embeds the Windows app icon for Start menu and desktop shortcuts", () => {
    expect(pkg.winIcon).toBe("icon.ico");
  });
});
