import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type GuardModule = typeof import("../core-dump-guard");

type WriteFailure = "none" | "enoent" | "eacces";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
const originalWslDistroName = process.env["WSL_DISTRO_NAME"];
const originalWslInterop = process.env["WSL_INTEROP"];
const originalKeepDumps = process.env["TRAYCER_KEEP_KERNEL_CORE_DUMPS"];

afterEach(() => {
  if (originalPlatformDescriptor === undefined) {
    Reflect.deleteProperty(process, "platform");
  } else {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  restoreEnvValue("WSL_DISTRO_NAME", originalWslDistroName);
  restoreEnvValue("WSL_INTEROP", originalWslInterop);
  restoreEnvValue("TRAYCER_KEEP_KERNEL_CORE_DUMPS", originalKeepDumps);
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("../logger");
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("suppressWslKernelCoreDumps", () => {
  it("does nothing on non-Linux platforms", async () => {
    const { guard, writeFileSyncMock } = await loadGuard({
      platform: "darwin",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: undefined,
      writeFailure: "none",
      filterReadback: "00000000",
    });

    guard.suppressWslKernelCoreDumps();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("clears coredump_filter under WSL, detected via WSL_DISTRO_NAME", async () => {
    const { guard, writeFileSyncMock, infoMock, errorMock } = await loadGuard({
      platform: "linux",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: undefined,
      writeFailure: "none",
      filterReadback: "00000000",
    });

    guard.suppressWslKernelCoreDumps();

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/proc/self/coredump_filter",
      "0",
    );
    expect(infoMock).toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("clears coredump_filter under WSL, detected via /proc/version", async () => {
    const { guard, writeFileSyncMock } = await loadGuard({
      platform: "linux",
      wslDistroName: undefined,
      procVersion: "Linux version 5.15.90.1-microsoft-standard-WSL2",
      keepDumps: undefined,
      writeFailure: "none",
      filterReadback: "00000000",
    });

    guard.suppressWslKernelCoreDumps();

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/proc/self/coredump_filter",
      "0",
    );
  });

  it("is a no-op on non-WSL Linux", async () => {
    const { guard, writeFileSyncMock } = await loadGuard({
      platform: "linux",
      wslDistroName: undefined,
      procVersion: "Linux version 6.5.0-generic",
      keepDumps: undefined,
      writeFailure: "none",
      filterReadback: "00000000",
    });

    guard.suppressWslKernelCoreDumps();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("keeps kernel core dumps when the env override is set", async () => {
    const { guard, writeFileSyncMock, infoMock } = await loadGuard({
      platform: "linux",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: "1",
      writeFailure: "none",
      filterReadback: "00000000",
    });

    guard.suppressWslKernelCoreDumps();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalled();
  });

  it("treats an absent coredump_filter (ENOENT) as safe, not an error", async () => {
    const { guard, infoMock, errorMock } = await loadGuard({
      platform: "linux",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: undefined,
      writeFailure: "enoent",
      filterReadback: "00000000",
    });

    expect(() => guard.suppressWslKernelCoreDumps()).not.toThrow();
    expect(infoMock).toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("escalates any other write failure to log.error and survives", async () => {
    const { guard, errorMock } = await loadGuard({
      platform: "linux",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: undefined,
      writeFailure: "eacces",
      filterReadback: "00000000",
    });

    expect(() => guard.suppressWslKernelCoreDumps()).not.toThrow();
    expect(errorMock).toHaveBeenCalled();
  });

  it("escalates a readback mismatch to log.error", async () => {
    const { guard, errorMock, infoMock } = await loadGuard({
      platform: "linux",
      wslDistroName: "Ubuntu",
      procVersion: null,
      keepDumps: undefined,
      writeFailure: "none",
      filterReadback: "00000033",
    });

    guard.suppressWslKernelCoreDumps();

    expect(errorMock).toHaveBeenCalled();
    expect(infoMock).not.toHaveBeenCalled();
  });
});

async function loadGuard(opts: {
  readonly platform: NodeJS.Platform;
  readonly wslDistroName: string | undefined;
  readonly procVersion: string | null;
  readonly keepDumps: string | undefined;
  readonly writeFailure: WriteFailure;
  readonly filterReadback: string;
}): Promise<{
  readonly guard: GuardModule;
  readonly writeFileSyncMock: Mock;
  readonly infoMock: Mock;
  readonly warnMock: Mock;
  readonly errorMock: Mock;
}> {
  vi.resetModules();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: opts.platform,
  });
  restoreEnvValue("WSL_DISTRO_NAME", opts.wslDistroName);
  Reflect.deleteProperty(process.env, "WSL_INTEROP");
  restoreEnvValue("TRAYCER_KEEP_KERNEL_CORE_DUMPS", opts.keepDumps);

  const writeFileSyncMock: Mock = vi.fn(() => {
    if (opts.writeFailure === "enoent") {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, open '/proc/self/coredump_filter'",
        ),
        { code: "ENOENT" },
      );
    }
    if (opts.writeFailure === "eacces") {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    }
  });
  const fs = {
    existsSync: vi.fn(
      (path: string) => path === "/proc/version" && opts.procVersion !== null,
    ),
    readFileSync: vi.fn((path: string) => {
      if (path === "/proc/version") {
        return opts.procVersion ?? "";
      }
      if (path === "/proc/self/coredump_filter") {
        return `${opts.filterReadback}\n`;
      }
      return "";
    }),
    writeFileSync: writeFileSyncMock,
  };
  vi.doMock("node:fs", () => ({ ...fs, default: fs }));

  const infoMock: Mock = vi.fn();
  const warnMock: Mock = vi.fn();
  const errorMock: Mock = vi.fn();
  vi.doMock("../logger", () => ({
    log: { debug: vi.fn(), info: infoMock, warn: warnMock, error: errorMock },
  }));

  return {
    guard: await import("../core-dump-guard"),
    writeFileSyncMock,
    infoMock,
    warnMock,
    errorMock,
  };
}
