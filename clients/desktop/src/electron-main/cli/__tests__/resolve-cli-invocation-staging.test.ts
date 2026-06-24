import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Internal-only `staging` deploy slot. Like dev, staging is a NON-production
// build, but unlike dev it is NOT `isDevBuild`. CLI discovery must still skip
// the PATH lookup for it: a developer's machine routinely has a released/prod
// `traycer` on PATH (Homebrew, `~/.traycer/cli/bin` symlinked into the prod
// `Traycer.app`), and adopting it would drive the staging app's `host
// ensure`/`host start` through a PRODUCTION CLI - onto the prod host slot
// (`ai.traycer.host`) and prod cloud, leaving the staging splash stuck on
// "Starting local Traycer Host...". PATH trust is production-only; every other
// slot uses its bundled/slot CLI. These tests pin that contract.

let work: string;
let homeDir: string;
let resourcesDir: string;

function bundledCliBinaryName(): string {
  return process.platform === "win32" ? "traycer.exe" : "traycer";
}

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function stageBundledArchCli(): string {
  const p = join(
    resourcesDir,
    "cli",
    `${process.platform}-${process.arch}`,
    bundledCliBinaryName(),
  );
  writeExecutable(p);
  return p;
}

function writeManifestAt(manifestPath: string, binaryPath: string): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "0.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "desktop",
      pendingUpgrade: null,
    }),
    "utf8",
  );
}

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/desktop-app",
  },
}));

// Pin the staging slot: non-dev (so discovery reaches the PATH section) but
// non-production (so the PATH section must be skipped). The env-scoped CLI home
// resolves to `~/.traycer/cli/staging`.
vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: false,
    config: { ...actual.config, environment: "staging" },
  };
});

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-cli-discovery-staging-"));
  homeDir = join(work, "home");
  resourcesDir = join(work, "resources");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  process.env.HOME = homeDir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = homeDir;
  }
  Object.defineProperty(process, "resourcesPath", {
    value: resourcesDir,
    configurable: true,
  });
  vi.resetModules();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.resetModules();
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
});

describe("resolveTraycerCliInvocation (staging slot) - env-scoped resolution", () => {
  it("skips a `traycer` on PATH and uses the bundled Staging.app CLI (a prod CLI on PATH must not hijack the staging slot)", async () => {
    // Simulate the user's released/prod CLI on PATH (Homebrew / the
    // `~/.traycer/cli/bin` symlink into the production Traycer.app).
    const fakePathBin = join(work, "fake-prod-cli-bin", bundledCliBinaryName());
    writeExecutable(fakePathBin);
    process.env.PATH = dirname(fakePathBin);

    // The Staging.app bundles its own arch-scoped CLI under resources/cli/.
    const bundled = stageBundledArchCli();

    const { resolveTraycerCliInvocation } = await import("../traycer-cli");
    const inv = await resolveTraycerCliInvocation();
    expect(inv.command).toBe(bundled);
    expect(inv.command).not.toBe(fakePathBin);
  });

  it("reads the staging-slot manifest, never the prod slot's", async () => {
    // A leftover prod install wrote `~/.traycer/cli/manifest.json`; the staging
    // slot must read `~/.traycer/cli/staging/manifest.json` instead.
    const prodBin = join(
      homeDir,
      ".traycer",
      "cli",
      "bin",
      bundledCliBinaryName(),
    );
    writeExecutable(prodBin);
    writeManifestAt(join(homeDir, ".traycer", "cli", "manifest.json"), prodBin);

    const stagingBin = join(
      homeDir,
      ".traycer",
      "cli",
      "staging",
      "bin",
      bundledCliBinaryName(),
    );
    writeExecutable(stagingBin);
    writeManifestAt(
      join(homeDir, ".traycer", "cli", "staging", "manifest.json"),
      stagingBin,
    );

    const { resolveTraycerCliInvocation } = await import("../traycer-cli");
    const inv = await resolveTraycerCliInvocation();
    expect(inv.command).toBe(stagingBin);
  });
});
