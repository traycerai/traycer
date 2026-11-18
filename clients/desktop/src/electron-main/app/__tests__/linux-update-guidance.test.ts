import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type GuidanceModule = typeof import("../linux-update-guidance");

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
const originalWslDistroName = process.env["WSL_DISTRO_NAME"];
const originalWslInterop = process.env["WSL_INTEROP"];

afterEach(() => {
  if (originalResourcesPathDescriptor === undefined) {
    Reflect.deleteProperty(process, "resourcesPath");
  } else {
    Object.defineProperty(
      process,
      "resourcesPath",
      originalResourcesPathDescriptor,
    );
  }
  restoreEnvValue("WSL_DISTRO_NAME", originalWslDistroName);
  restoreEnvValue("WSL_INTEROP", originalWslInterop);
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("readLinuxPackageType", () => {
  it("returns null when package-type is missing", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });
    expect(guidance.readLinuxPackageType()).toBeNull();
  });

  it("reads 'deb' from the package-type file", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: "deb",
      procVersion: null,
    });
    expect(guidance.readLinuxPackageType()).toBe("deb");
  });

  it("reads 'rpm' from the package-type file", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: "rpm",
      procVersion: null,
    });
    expect(guidance.readLinuxPackageType()).toBe("rpm");
  });

  it("returns null for an unrecognized package-type value", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: "pacman",
      procVersion: null,
    });
    expect(guidance.readLinuxPackageType()).toBeNull();
  });
});

describe("resolveLinuxSilentInstallSupported", () => {
  it("is false under WSL, detected via WSL_DISTRO_NAME, without probing dpkg", async () => {
    process.env["WSL_DISTRO_NAME"] = "Ubuntu";
    const { guidance, execFileMock } = await loadGuidance({
      packageTypeFile: "deb",
      procVersion: null,
      execFileSucceeds: true,
    });

    await expect(
      guidance.resolveLinuxSilentInstallSupported("deb"),
    ).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("is false under WSL, detected via /proc/version", async () => {
    const { guidance, execFileMock } = await loadGuidance({
      packageTypeFile: "deb",
      procVersion: "Linux version 5.15.90.1-microsoft-standard-WSL2",
      execFileSucceeds: true,
    });

    await expect(
      guidance.resolveLinuxSilentInstallSupported("deb"),
    ).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("is true when dpkg confirms it owns the running binary", async () => {
    const { guidance, execFileMock } = await loadGuidance({
      packageTypeFile: "deb",
      procVersion: "Linux version 6.5.0-generic",
      execFileSucceeds: true,
    });

    await expect(
      guidance.resolveLinuxSilentInstallSupported("deb"),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "dpkg",
      ["-S", expect.any(String)],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("is false when dpkg doesn't know the running binary (unregistered install)", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: "deb",
      procVersion: "Linux version 6.5.0-generic",
      execFileSucceeds: false,
    });

    await expect(
      guidance.resolveLinuxSilentInstallSupported("deb"),
    ).resolves.toBe(false);
  });

  it("queries rpm -qf for an rpm install", async () => {
    const { guidance, execFileMock } = await loadGuidance({
      packageTypeFile: "rpm",
      procVersion: "Linux version 6.5.0-generic",
      execFileSucceeds: true,
    });

    await expect(
      guidance.resolveLinuxSilentInstallSupported("rpm"),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "rpm",
      ["-qf", expect.any(String)],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });
});

describe("buildLinuxUpdateGuidance", () => {
  it("builds a dpkg command for a deb install", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });

    const result = guidance.buildLinuxUpdateGuidance(
      "deb",
      "1.2.0",
      "/home/user/.cache/traycer-updater/pending/traycer.deb",
    );

    expect(result.command).toBe(
      'sudo dpkg -i "/home/user/.cache/traycer-updater/pending/traycer.deb"',
    );
    expect(result.summary).toContain("v1.2.0");
  });

  it("builds an rpm command for an rpm install", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });

    const result = guidance.buildLinuxUpdateGuidance(
      "rpm",
      "1.2.0",
      "/home/user/.cache/traycer-updater/pending/traycer.rpm",
    );

    expect(result.command).toBe(
      'sudo rpm -U "/home/user/.cache/traycer-updater/pending/traycer.rpm"',
    );
  });

  it("returns a null command when no file has been downloaded yet", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });

    const result = guidance.buildLinuxUpdateGuidance("deb", "1.2.0", null);

    expect(result.command).toBeNull();
  });

  it("falls back to generic wording when the version is unknown", async () => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });

    const result = guidance.buildLinuxUpdateGuidance("deb", null, null);

    expect(result.summary).toContain("the update");
  });
});

describe("isLinuxEscalationError", () => {
  it.each([
    "Command pkexec exited with code 127",
    "Command sudo exited with code 1",
    "Command dpkg exited with code 2",
    "Neither dpkg nor apt command found. Cannot install .deb package.",
  ])("matches escalation failure message: %s", async (message) => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });
    expect(guidance.isLinuxEscalationError(message)).toBe(true);
  });

  it.each([
    "ENOSPC: no space left on device",
    "sha512 checksum mismatch",
    "getaddrinfo ENOTFOUND",
  ])("does not match unrelated failure message: %s", async (message) => {
    const { guidance } = await loadGuidance({
      packageTypeFile: null,
      procVersion: null,
    });
    expect(guidance.isLinuxEscalationError(message)).toBe(false);
  });
});

interface FakeFs {
  existsSync: Mock;
  readFileSync: Mock;
}

async function loadGuidance(opts: {
  readonly packageTypeFile: string | null;
  readonly procVersion: string | null;
  readonly execFileSucceeds?: boolean;
}): Promise<{
  readonly guidance: GuidanceModule;
  readonly execFileMock: Mock;
}> {
  vi.resetModules();
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/traycer-test-resources",
    writable: true,
  });

  const fs: FakeFs = {
    existsSync: vi.fn((path: string) => {
      if (path.endsWith("package-type")) return opts.packageTypeFile !== null;
      if (path === "/proc/version") return opts.procVersion !== null;
      return false;
    }),
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith("package-type")) return opts.packageTypeFile ?? "";
      if (path === "/proc/version") return opts.procVersion ?? "";
      return "";
    }),
  };
  const execFileMock: Mock = vi.fn((_command, _args, _options, callback) => {
    if (opts.execFileSucceeds === false) {
      callback(new Error("command failed"), "", "");
    } else {
      callback(null, "", "");
    }
  });

  const fsPromises = {
    realpath: vi.fn((path: string) => Promise.resolve(path)),
  };
  const childProcess = { execFile: execFileMock };
  vi.doMock("node:fs", () => ({ ...fs, default: fs }));
  vi.doMock("node:fs/promises", () => ({ ...fsPromises, default: fsPromises }));
  vi.doMock("node:child_process", () => ({
    ...childProcess,
    default: childProcess,
  }));

  return {
    guidance: await import("../linux-update-guidance"),
    execFileMock,
  };
}
