import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const osMock = vi.hoisted(() => ({
  platform: vi.fn(),
  arch: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: osMock.platform, arch: osMock.arch };
});

import { resolveBundledHostArchive } from "../bundled-host";

let scratchRoot: string;
let originalExecPath: string;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "traycer-bundled-host-"));
  originalExecPath = process.execPath;
  Object.defineProperty(process, "execPath", {
    value: join(scratchRoot, "traycer.exe"),
    configurable: true,
  });
  osMock.platform.mockReset();
  osMock.arch.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "execPath", {
    value: originalExecPath,
    configurable: true,
  });
  rmSync(scratchRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("resolveBundledHostArchive", () => {
  it("resolves bundled Windows host zips next to the CLI binary", async () => {
    osMock.platform.mockReturnValue("win32");
    osMock.arch.mockReturnValue("x64");
    const archive = join(scratchRoot, "host-runtime-win32-x64.zip");
    writeFileSync(archive, "");

    await expect(resolveBundledHostArchive()).resolves.toBe(archive);
  });

  it("resolves Windows arm64 to the x64 host archive", async () => {
    osMock.platform.mockReturnValue("win32");
    osMock.arch.mockReturnValue("arm64");
    const archive = join(scratchRoot, "host-runtime-win32-x64.zip");
    writeFileSync(archive, "");

    await expect(resolveBundledHostArchive()).resolves.toBe(archive);
  });

  it("keeps tarball lookup for non-Windows platforms", async () => {
    osMock.platform.mockReturnValue("darwin");
    osMock.arch.mockReturnValue("arm64");
    const archive = join(scratchRoot, "host-runtime-darwin-arm64.tar.gz");
    writeFileSync(archive, "");

    await expect(resolveBundledHostArchive()).resolves.toBe(archive);
  });
});
