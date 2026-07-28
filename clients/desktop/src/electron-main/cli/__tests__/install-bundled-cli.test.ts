import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The slot used to be a POSIX symlink into the .app bundle - field report
// 5's "file exists but won't run": remove or replace the bundle and the
// link dangles, `ls`/lstat still succeed, exec fails ENOENT, and the only
// healer ran at the next *successful* app launch - circular exactly when
// the app is the broken part. The slot is now a COPY on every platform.
// These tests pin the property that closes the class: the staged binary
// must survive its bundled source disappearing.

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

vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: false,
    config: { ...actual.config, environment: "production" },
  };
});

let work: string;
let homeDir: string;

const CLI_BINARY_NAME =
  process.platform === "win32" ? "traycer.exe" : "traycer";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-install-bundled-cli-"));
  homeDir = join(work, "home");
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = homeDir;
  }
  vi.resetModules();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.resetModules();
});

function stageBundled(content: string): string {
  const bundleCliDir = join(
    work,
    "Traycer.app",
    "Contents",
    "Resources",
    "cli",
  );
  mkdirSync(bundleCliDir, { recursive: true });
  const bundled = join(bundleCliDir, CLI_BINARY_NAME);
  writeFileSync(bundled, content);
  return bundled;
}

describe("installBundledCli stages a copy that outlives the bundle", () => {
  it("stages a regular executable file (never a symlink) and writes the manifest", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");

    const stable = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    expect(lstatSync(stable).isSymbolicLink()).toBe(false);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
    if (process.platform !== "win32") {
      expect(statSync(stable).mode & 0o111).not.toBe(0);
    }
    const manifest: { binaryPath: string; version: string } = JSON.parse(
      readFileSync(join(homeDir, ".traycer", "cli", "manifest.json"), "utf8"),
    );
    expect(manifest.binaryPath).toBe(stable);
    expect(manifest.version).toBe("1.0.0");
  });

  it("keeps working after the bundle is deleted - the exact class of field report 5", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");
    const stable = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    rmSync(join(work, "Traycer.app"), { recursive: true, force: true });

    // `stat` FOLLOWS links: with the old symlink staging this is exactly
    // where ENOENT surfaced while lstat (and `ls`) kept succeeding.
    expect(statSync(stable).size).toBeGreaterThan(0);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
  });

  it.runIf(process.platform !== "win32")(
    "replaces a legacy dangling symlink from the pre-copy era with a real copy",
    async () => {
      const bundled = stageBundled("cli-bytes-v2");
      const binDir = join(homeDir, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const legacySlot = join(binDir, "traycer");
      symlinkSync(join(work, "removed-bundle-target"), legacySlot);

      const { installBundledCli } = await import("../cli-discovery");
      const stable = await installBundledCli({
        bundledCliPath: bundled,
        version: "2.0.0",
        source: "desktop",
      });

      expect(stable).toBe(legacySlot);
      expect(lstatSync(stable).isSymbolicLink()).toBe(false);
      expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v2");
    },
  );
});
