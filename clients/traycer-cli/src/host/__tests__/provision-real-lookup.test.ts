import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

const mocks = vi.hoisted(() => ({
  installHostMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  installHost: mocks.installHostMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

const {
  installHostMock,
  readHostInstallRecordMock,
  createServiceControllerMock,
  serviceLabelForMock,
} = mocks;

import { provisionHost } from "../provision";

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceLabelForMock.mockReturnValue({
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production",
    devSlot: null,
  });
  readHostInstallRecordMock.mockResolvedValue({
    version: "1.7.2",
    runtimeVersion: null,
  });
  createServiceControllerMock.mockReturnValue({
    status: vi.fn(async () => ({
      state: "running",
      version: null,
      listenUrl: null,
      pid: null,
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provisionHost real yank lookup construction", () => {
  it("does not fetch the manifest when the installed version equals the implicit target", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("manifest fetch must not run"));

    const result = await provisionHost({
      runtime: makeRuntime(),
      resolveInstallSource: () =>
        Promise.resolve({ kind: "registry", versionRequest: "1.7.2" }),
      satisfaction: {
        kind: "implicit-registry-minimum",
        version: "1.7.2",
      },
      recordVersionOverride: null,
      enableLinger: true,
      allowSelfInvocation: true,
      registerService: true,
      lockReason: "test",
      onProgress: null,
      force: false,
    });

    expect(result.action).toBe("noop");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(installHostMock).not.toHaveBeenCalled();
  });
});
