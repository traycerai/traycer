import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { PathLike, RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function stagingRootFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install-staging");
}

// Mirrors stage-reconcile.test.ts's seam: forces `unlink`/`rm` to fail for
// one specific path while every other path proxies through to the real
// implementation - the exact two operations layered invalidation's layer 2
// and layer 3 depend on.
const mocks = vi.hoisted(() => ({
  forceUnlinkFailureForPath: null as string | null,
  forceRmFailureForPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: PathLike) => {
      if (path === mocks.forceUnlinkFailureForPath) {
        throw Object.assign(new Error("simulated unlink failure"), {
          code: "EPERM",
        });
      }
      return actual.unlink(path);
    },
    rm: async (path: PathLike, options: RmOptions) => {
      if (path === mocks.forceRmFailureForPath) {
        throw Object.assign(new Error("simulated rm failure"), {
          code: "EPERM",
        });
      }
      return actual.rm(path, options);
    },
  };
});

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  return {
    ...actual,
    hostHomeDir: (environment: Environment) => hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagingRoot: (environment: Environment) => stagingRootFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(stagingRootFor(environment), { recursive: true });
    },
  };
});

import { installHost, sweepOldTrash } from "../install";
import { readHostInstallRecord } from "../../manifest/host-install";
import { createCliLogger } from "../../logger";

const ENV: Environment = "production";

function writeLocalHostSource(sourceDir: string, marker: string): void {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "traycer-host"), `binary-${marker}`);
}

describe("sweepOldTrash", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("invalidates install.old-* litter even when the sidecar unlink AND the recursive removal both fail", async () => {
    // Same shape as stage-reconcile.test.ts's identical staged-aside test:
    // the rename-to-`.dead-*` primary layer is left real (not forced to
    // fail), so forcing exactly the two operations that were the pre-parity
    // implementation's whole defense to fail no longer matters - the
    // candidate is already structurally invisible to the `.old-*` scan
    // before unlink/rm are ever reached.
    const installDir = installDirFor(ENV);
    mkdirSync(installDir, { recursive: true });
    const asideDir = `${installDir}.old-${Date.now()}`;
    mkdirSync(asideDir, { recursive: true });
    writeFileSync(join(asideDir, "install.json"), '{"version":"1.0.0"}');
    mocks.forceUnlinkFailureForPath = join(asideDir, "install.json");
    mocks.forceRmFailureForPath = asideDir;

    const logger = createCliLogger(ENV);
    await sweepOldTrash(installDir, logger);

    expect(existsSync(asideDir)).toBe(false);
    // Not restorable by a subsequent sweep either - nothing is left under
    // the `.old-*` prefix that `sweepOldTrash`'s listing scans.
    const remaining = readdirSync(hostHomeFor(ENV)).filter((name) =>
      name.includes(".old-"),
    );
    expect(remaining).toEqual([]);
  });
});

describe("installHost", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("mints a fresh installId on every successful install", async () => {
    const sourceDir = join(sandboxRoot, "source-1");
    writeLocalHostSource(sourceDir, "v1");

    const { record } = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: sourceDir },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "1.0.0",
    });

    expect(record.installId).not.toBeNull();
    expect(typeof record.installId).toBe("string");
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.installId).toBe(record.installId);
  });

  it("replaces an existing install and leaves no install.old-* trash behind", async () => {
    const firstSource = join(sandboxRoot, "source-1");
    writeLocalHostSource(firstSource, "v1");
    const first = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: firstSource },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "1.0.0",
    });

    const secondSource = join(sandboxRoot, "source-2");
    writeLocalHostSource(secondSource, "v2");
    const second = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: secondSource },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "2.0.0",
    });

    expect(second.previous?.version).toBe("1.0.0");
    expect(second.record.version).toBe("2.0.0");
    // installId is a fresh identity per materialization, not reused across
    // installs - see the shared install-generation fingerprint module.
    expect(second.record.installId).not.toBe(first.record.installId);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v2",
    );

    const leftoverTrash = readdirSync(hostHomeFor(ENV)).filter((name) =>
      name.includes(".old-"),
    );
    expect(leftoverTrash).toEqual([]);
  });
});
