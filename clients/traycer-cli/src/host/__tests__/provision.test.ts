import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

const mocks = vi.hoisted(() => ({
  installHostMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  withCliLockMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  createRegistryYankLookupMock: vi.fn(),
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

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: mocks.withCliLockMock,
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

vi.mock("../../registry/client", () => ({
  createRegistryYankLookup: mocks.createRegistryYankLookupMock,
}));

const {
  installHostMock,
  readHostInstallRecordMock,
  createServiceControllerMock,
  serviceLabelForMock,
  resolveServiceCliInvocationMock,
  createServiceInstallLifecycleMock,
  withCliLockMock,
  assertHostNotBusyMock,
  createRegistryYankLookupMock,
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

function makeController(state: "running" | "stopped" | "not-installed") {
  let current = state;
  return {
    status: vi.fn(async () => ({
      state: current,
      version: null,
      listenUrl: null,
      pid: null,
    })),
    install: vi.fn(async () => {
      current = "running";
    }),
    start: vi.fn(async () => {
      current = "running";
    }),
    uninstall: vi.fn(async () => {
      current = "not-installed";
    }),
    stop: vi.fn(async () => {
      current = "stopped";
    }),
    restart: vi.fn(async () => {
      current = "running";
    }),
  };
}

function makeOptions(
  satisfaction:
    | { readonly kind: "presence" }
    | { readonly kind: "exact"; readonly version: string }
    | {
        readonly kind: "implicit-registry-minimum";
        readonly version: string;
      },
  registerService: boolean,
) {
  return {
    runtime: makeRuntime(),
    resolveInstallSource: () =>
      Promise.resolve({ kind: "registry" as const, versionRequest: "1.7.2" }),
    satisfaction,
    recordVersionOverride: null,
    enableLinger: true,
    allowSelfInvocation: true,
    registerService,
    lockReason: "test",
    onProgress: null,
    force: false,
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
  resolveServiceCliInvocationMock.mockResolvedValue({
    command: "/usr/local/bin/traycer",
    args: [],
  });
  createServiceInstallLifecycleMock.mockReturnValue({
    state: {
      priorState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    },
    lifecycle: { beforeSwap: vi.fn(), afterSwap: vi.fn() },
  });
  withCliLockMock.mockImplementation(
    async (_options: unknown, callback: () => Promise<unknown>) => callback(),
  );
  assertHostNotBusyMock.mockResolvedValue(undefined);
  createRegistryYankLookupMock.mockReturnValue({
    isVersionYanked: vi.fn(async () => false),
  });
  installHostMock.mockResolvedValue({
    record: { version: "1.7.2", runtimeVersion: null },
    previous: null,
  });
});

describe("provisionHost satisfaction", () => {
  it("re-reads satisfaction after losing the lock race and observes the winner install", async () => {
    readHostInstallRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ version: "1.7.2", runtimeVersion: null });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await provisionHost(
      makeOptions({ kind: "exact", version: "1.7.2" }, true),
    );

    expect(result.action).toBe("noop");
    expect(readHostInstallRecordMock).toHaveBeenCalledTimes(2);
    expect(installHostMock).not.toHaveBeenCalled();
  });

  it("never treats an invalid installed SemVer as satisfied", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "1.7",
      runtimeVersion: null,
    });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await provisionHost(
      makeOptions(
        { kind: "implicit-registry-minimum", version: "1.7.2" },
        true,
      ),
    );

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
  });

  it("never treats an invalid implicit target SemVer as satisfied", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "2.0.0",
      runtimeVersion: null,
    });
    const isVersionYanked = vi.fn(async () => false);
    createRegistryYankLookupMock.mockReturnValue({ isVersionYanked });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await provisionHost(
      makeOptions(
        { kind: "implicit-registry-minimum", version: "not-semver" },
        true,
      ),
    );

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
    expect(isVersionYanked).not.toHaveBeenCalled();
  });

  it("fails open when a newer installed version is absent from the manifest", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "2.0.0",
      runtimeVersion: null,
    });
    const isVersionYanked = vi.fn(async () => false);
    createRegistryYankLookupMock.mockReturnValue({ isVersionYanked });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await provisionHost(
      makeOptions(
        { kind: "implicit-registry-minimum", version: "1.7.2" },
        true,
      ),
    );

    expect(result.action).toBe("noop");
    expect(isVersionYanked).toHaveBeenCalledWith("2.0.0");
    expect(installHostMock).not.toHaveBeenCalled();
  });

  it("reinstalls a newer installed version when the manifest marks it yanked", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "2.0.0",
      runtimeVersion: null,
    });
    createRegistryYankLookupMock.mockReturnValue({
      isVersionYanked: vi.fn(async () => true),
    });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await provisionHost(
      makeOptions(
        { kind: "implicit-registry-minimum", version: "1.7.2" },
        true,
      ),
    );

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
  });

  it("does not consult the manifest when installed equals the target", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "1.7.2",
      runtimeVersion: "rebuilt-host-stamp",
    });
    const isVersionYanked = vi.fn(async () => true);
    createRegistryYankLookupMock.mockReturnValue({ isVersionYanked });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await provisionHost(
      makeOptions(
        { kind: "implicit-registry-minimum", version: "1.7.2" },
        true,
      ),
    );

    expect(result.action).toBe("noop");
    expect(isVersionYanked).not.toHaveBeenCalled();
    expect(installHostMock).not.toHaveBeenCalled();
  });

  it("keeps exact own-build matching strict for rebuilt same-version records", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      version: "1.7.2-rebuilt",
      runtimeVersion: "1.7.2-rebuilt",
    });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await provisionHost(
      makeOptions({ kind: "exact", version: "1.7.2" }, true),
    );

    expect(result.action).toBe("installed");
    expect(installHostMock).toHaveBeenCalledTimes(1);
  });
});
