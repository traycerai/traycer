import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const osMock = vi.hoisted(() => ({
  platform: vi.fn(),
  arch: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: osMock.platform, arch: osMock.arch };
});

import { currentHostPlatformKey } from "../platform-key";

beforeEach(() => {
  osMock.platform.mockReset();
  osMock.arch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("currentHostPlatformKey", () => {
  // Windows ships x64-only (no win-arm64 host: sherpa-onnx has no win-arm64
  // binary). Windows 11 on ARM runs the x64 build under emulation, so arm64
  // must resolve to win32-x64 for both host download and CLI self-resolution.
  it("resolves Windows arm64 to win32-x64 (x64 emulation)", () => {
    osMock.platform.mockReturnValue("win32");
    osMock.arch.mockReturnValue("arm64");
    expect(currentHostPlatformKey()).toBe("win32-x64");
  });

  it("passes Windows x64 through unchanged", () => {
    osMock.platform.mockReturnValue("win32");
    osMock.arch.mockReturnValue("x64");
    expect(currentHostPlatformKey()).toBe("win32-x64");
  });

  it("keeps native arm64 on macOS and Linux (those ship native arm64 hosts)", () => {
    osMock.platform.mockReturnValue("darwin");
    osMock.arch.mockReturnValue("arm64");
    expect(currentHostPlatformKey()).toBe("darwin-arm64");

    osMock.platform.mockReturnValue("linux");
    osMock.arch.mockReturnValue("arm64");
    expect(currentHostPlatformKey()).toBe("linux-arm64");
  });

  it("throws for a genuinely unsupported platform/arch", () => {
    osMock.platform.mockReturnValue("win32");
    osMock.arch.mockReturnValue("ia32");
    expect(() => currentHostPlatformKey()).toThrow();
  });
});
