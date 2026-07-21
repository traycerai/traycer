import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => "/tmp/traycer-test",
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { TraycerCliError } from "../../cli/traycer-cli";
import { categorizeHostCliError } from "../host-readiness";

describe("categorizeHostCliError", () => {
  it("categorizes E_REGISTRY_UNAVAILABLE as offline and preserves its code", () => {
    const error = new TraycerCliError(
      {
        message: "host registry unavailable",
        code: "E_REGISTRY_UNAVAILABLE",
        details: { url: "https://registry.example.test/versions.json" },
        exitCode: 1,
        stderrTail: "offline",
      },
      null,
    );

    expect(categorizeHostCliError(error)).toEqual({
      kind: "offline",
      message:
        "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
      code: "E_REGISTRY_UNAVAILABLE",
    });
  });

  it("leaves unrelated CLI codes as unknown while preserving the code", () => {
    const error = new TraycerCliError("E_HOST_BUSY", "host is busy");

    expect(categorizeHostCliError(error)).toEqual({
      kind: "host-busy",
      message:
        "The host has work in progress, so it was not restarted. Checking whether this build can keep using it…",
      code: "E_HOST_BUSY",
    });
  });
});
