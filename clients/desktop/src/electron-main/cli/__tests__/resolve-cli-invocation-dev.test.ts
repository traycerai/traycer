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

import devWrapperPaths from "../dev-wrapper-paths.json";

// The desktop's `~/.traycer/cli/` paths are environment-scoped (matching the
// CLI package's store/paths.ts): the dev slot lives under
// `~/.traycer/cli/dev/`. CLI discovery resolves: (1) dev-slot manifest, then
// (2) the staged dev wrapper (`~/.traycer/cli/dev/bin/traycer`). The PATH
// lookup step is intentionally SKIPPED in dev - a dev workspace inevitably
// has `node_modules/.bin/traycer` on PATH (bun's bin hoisting), and falling
// through PATH first would pick the package symlink ahead of the wrapper
// `make dev-desktop` staged. These tests pin both halves plus the PATH
// regression.

let work: string;
let homeDir: string;

function devWrapperPath(): string {
  const filename =
    process.platform === "win32"
      ? devWrapperPaths.filenameWin32
      : devWrapperPaths.filenamePosix;
  return join(homeDir, ...devWrapperPaths.segments, filename);
}

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
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

// Pin the dev slot so the env-scoped CLI home resolves to `~/.traycer/cli/dev`.
vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: true,
    config: { ...actual.config, environment: "dev" },
  };
});

// Snapshot env vars at module load so the test cases below can mutate
// `process.env.PATH` (and HOME/USERPROFILE) freely without leaking into
// sibling test files when this suite finishes. `afterEach` restores
// every test, not just the one that mutated, so a test that throws
// before its own cleanup still leaves the env clean for the next.
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-cli-discovery-dev-"));
  homeDir = join(work, "home");
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = homeDir;
  }
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

describe("resolveTraycerCliInvocation (dev slot) - env-scoped resolution", () => {
  it("resolves the dev-slot manifest, never the prod slot's", async () => {
    // A leftover prod install wrote `~/.traycer/cli/manifest.json`; the dev
    // slot must read `~/.traycer/cli/dev/manifest.json` instead.
    const prodBin = join(homeDir, ".traycer", "cli", "bin", "traycer");
    writeExecutable(prodBin);
    writeManifestAt(join(homeDir, ".traycer", "cli", "manifest.json"), prodBin);

    const devBin = devWrapperPath(); // ~/.traycer/cli/dev/bin/traycer
    writeExecutable(devBin);
    writeManifestAt(
      join(homeDir, ".traycer", "cli", "dev", "manifest.json"),
      devBin,
    );

    const { resolveTraycerCliInvocation } = await import("../traycer-cli");
    const inv = await resolveTraycerCliInvocation();
    expect(inv.command).toBe(devBin);
    expect(inv.args).toEqual([]);
  });

  it("falls back to the staged dev wrapper when the dev manifest is absent", async () => {
    // The dev slot ships no manifest: only the wrapper is staged by
    // `make dev-desktop`. PATH is wiped so we don't depend on the host's
    // workspace `node_modules/.bin/traycer` being absent - the staged
    // wrapper is the only candidate and resolves directly.
    process.env.PATH = "";
    const wrapper = devWrapperPath();
    writeExecutable(wrapper);

    const { resolveTraycerCliInvocation } = await import("../traycer-cli");
    const inv = await resolveTraycerCliInvocation();
    expect(inv.command).toBe(wrapper);
  });

  it("prefers the staged dev wrapper over a `traycer` on PATH (the workspace symlink case)", async () => {
    // Regression: a dev workspace has `node_modules/.bin/traycer` on PATH
    // because bun hoists package bins for `bun run` scripts. Before the
    // dev-skip in `discoverCli`, that symlink hijacked discovery and the
    // desktop ended up invoking it instead of the wrapper `make
    // dev-desktop` staged. Pin that the wrapper wins regardless of what's
    // on PATH so the OS service registration and ad-hoc CLI calls always
    // run through the orchestrator's wrapper.
    const fakePathBinDir = join(work, "fake-node-modules-bin");
    const fakePathBin = join(
      fakePathBinDir,
      process.platform === "win32" ? "traycer.exe" : "traycer",
    );
    writeExecutable(fakePathBin);
    process.env.PATH = fakePathBinDir;

    const wrapper = devWrapperPath();
    writeExecutable(wrapper);

    const { resolveTraycerCliInvocation } = await import("../traycer-cli");
    const inv = await resolveTraycerCliInvocation();
    expect(inv.command).toBe(wrapper);
    expect(inv.command).not.toBe(fakePathBin);
  });
});
