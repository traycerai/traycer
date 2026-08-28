import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// Production PATH discovery must walk EVERY `traycer` on PATH, not just the
// first executable with that name. The name is squattable - oss #872 saw an
// AppImage manager expose the desktop app itself as `traycer` - and a
// squatter sitting ahead of a real CLI must not hide it (nor make discovery
// report "nothing anywhere" while a usable CLI is still further down PATH).
//
// POSIX-only: the fixtures are `#!/bin/sh` scripts.

let work: string;
let homeDir: string;
let resourcesDir: string;

function cliName(): string {
  return process.platform === "win32" ? "traycer.exe" : "traycer";
}

// A `traycer` on PATH whose `--version` answer decides whether discovery may
// adopt it. `answersVersion: false` reproduces the #872 imposter shape: exit
// 0, console noise, no version - indistinguishable from a real CLI by name
// or exit code alone.
function writePathCli(dir: string, answersVersion: boolean): string {
  const path = join(dir, cliName());
  mkdirSync(dirname(path), { recursive: true });
  const body = answersVersion
    ? "printf '1.2.3\\n'"
    : "printf '[desktop] single-instance lock unavailable - quitting\\n'";
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function stageBundledArchCli(): string {
  const path = join(
    resourcesDir,
    "cli",
    `${process.platform}-${process.arch}`,
    cliName(),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
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

// PATH trust is production-only, so pin the production slot.
vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: false,
    config: { ...actual.config, environment: "production" },
  };
});

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-cli-path-scan-"));
  homeDir = join(work, "home");
  resourcesDir = join(work, "resources");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  sandboxHome(homeDir);
  Object.defineProperty(process, "resourcesPath", {
    value: resourcesDir,
    configurable: true,
  });
  // Fresh module registry per test so the module-level probe cache starts
  // empty and one test's verdict can never satisfy another's assertion.
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

describe.skipIf(process.platform === "win32")(
  "discoverCli - PATH scan past a rejected candidate",
  () => {
    it("skips a squatter and adopts a real CLI further down PATH", async () => {
      const squatterDir = join(work, "squatter-bin");
      const realDir = join(work, "real-bin");
      mkdirSync(squatterDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });
      const squatter = writePathCli(squatterDir, false);
      const real = writePathCli(realDir, true);
      // Squatter FIRST: stopping at the first executable would return it.
      process.env.PATH = [squatterDir, realDir].join(delimiter);
      stageBundledArchCli();

      const { discoverCli, CLI_INVOCATION_PROBE_TIMEOUT_MS } =
        await import("../cli-discovery");
      const result = await discoverCli(CLI_INVOCATION_PROBE_TIMEOUT_MS);
      expect(result.kind).toBe("path");
      if (result.kind === "path") {
        expect(result.binaryPath).toBe(real);
        expect(result.binaryPath).not.toBe(squatter);
        expect(result.version).toBe("1.2.3");
      }
    });

    it("falls through to the bundled CLI when every PATH candidate is a squatter", async () => {
      const squatterDir = join(work, "squatter-bin");
      mkdirSync(squatterDir, { recursive: true });
      writePathCli(squatterDir, false);
      process.env.PATH = squatterDir;
      const bundled = stageBundledArchCli();

      const { discoverCli, CLI_INVOCATION_PROBE_TIMEOUT_MS } =
        await import("../cli-discovery");
      const result = await discoverCli(CLI_INVOCATION_PROBE_TIMEOUT_MS);
      expect(result.kind).toBe("bundled");
      if (result.kind === "bundled") {
        expect(result.binaryPath).toBe(bundled);
      }
    });

    it("reports none - never the squatter - when no bundled CLI is reachable", async () => {
      const squatterDir = join(work, "squatter-bin");
      mkdirSync(squatterDir, { recursive: true });
      writePathCli(squatterDir, false);
      process.env.PATH = squatterDir;

      const { discoverCli, CLI_INVOCATION_PROBE_TIMEOUT_MS } =
        await import("../cli-discovery");
      const result = await discoverCli(CLI_INVOCATION_PROBE_TIMEOUT_MS);
      expect(result.kind).toBe("none");
    });

    it("adopts the FIRST healthy candidate when several answer (PATH order wins)", async () => {
      const firstDir = join(work, "first-bin");
      const secondDir = join(work, "second-bin");
      mkdirSync(firstDir, { recursive: true });
      mkdirSync(secondDir, { recursive: true });
      const first = writePathCli(firstDir, true);
      writePathCli(secondDir, true);
      process.env.PATH = [firstDir, secondDir].join(delimiter);
      stageBundledArchCli();

      const { discoverCli, CLI_INVOCATION_PROBE_TIMEOUT_MS } =
        await import("../cli-discovery");
      const result = await discoverCli(CLI_INVOCATION_PROBE_TIMEOUT_MS);
      expect(result.kind).toBe("path");
      if (result.kind === "path") {
        expect(result.binaryPath).toBe(first);
      }
    });
  },
);
