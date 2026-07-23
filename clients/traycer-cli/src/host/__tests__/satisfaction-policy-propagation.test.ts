import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

const mocks = vi.hoisted(() => ({
  provisionHostMock: vi.fn(),
  resolveBundledHostArchiveMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
}));

vi.mock("../provision", () => ({
  provisionHost: mocks.provisionHostMock,
}));

vi.mock("../../installer/bundled-host", () => ({
  resolveBundledHostArchive: mocks.resolveBundledHostArchiveMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

const {
  provisionHostMock,
  resolveBundledHostArchiveMock,
  readHostInstallRecordMock,
  createServiceControllerMock,
  serviceLabelForMock,
} = mocks;

import { config } from "../../config";
import { ensureHost, type EnsureHostOptions } from "../ensure";
import { maybeAutoBootstrap } from "../auto-bootstrap";

function makeRuntime(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
    ...overrides,
  };
}

function makeEnsureOptions(
  overrides: Partial<EnsureHostOptions>,
): EnsureHostOptions {
  return {
    runtime: makeRuntime({}),
    versionRequest: null,
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: true,
    noServiceRegister: false,
    force: false,
    onProgress: null,
    ...overrides,
  };
}

function makeResult() {
  return {
    installed: true,
    registered: true,
    running: true,
    version: "1.7.2",
    runtimeVersion: null,
    action: "installed" as const,
    serviceLifecycle: null,
    postSwapError: null,
  };
}

function makeServiceController(state: "running" | "not-installed") {
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
    uninstall: vi.fn(async () => {
      current = "not-installed";
    }),
    start: vi.fn(async () => {
      current = "running";
    }),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.supportedHostVersion = null;
  resolveBundledHostArchiveMock.mockResolvedValue(null);
  provisionHostMock.mockResolvedValue(makeResult());
  serviceLabelForMock.mockReturnValue({
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production",
    devSlot: null,
  });
});

describe("ensureHost satisfaction policy propagation", () => {
  it("passes presence for latest registry requests", async () => {
    await ensureHost(makeEnsureOptions({ versionRequest: "latest" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ satisfaction: { kind: "presence" } }),
    );
  });

  it("passes implicit-registry-minimum for the build-stamped registry source", async () => {
    config.supportedHostVersion = "1.7.2";

    await ensureHost(makeEnsureOptions({}));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: {
          kind: "implicit-registry-minimum",
          version: "1.7.2",
        },
      }),
    );
  });

  it("passes exact for explicit --release pins", async () => {
    await ensureHost(makeEnsureOptions({ versionRequest: "1.6.0" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "exact", version: "1.6.0" },
      }),
    );
  });

  it("passes exact against the CLI build for local-file sources", async () => {
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");

    await ensureHost(makeEnsureOptions({}));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "exact", version: config.version },
        recordVersionOverride: config.version,
      }),
    );
  });

  it("passes exact against the CLI build for explicit --from sources", async () => {
    await ensureHost(makeEnsureOptions({ fromPath: "/tmp/host.tar.gz" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveInstallSource: expect.any(Function),
        satisfaction: { kind: "exact", version: config.version },
        recordVersionOverride: config.version,
      }),
    );
    await expect(
      provisionHostMock.mock.calls[0]?.[0].resolveInstallSource(),
    ).resolves.toEqual({ kind: "local-file", path: "/tmp/host.tar.gz" });
  });
});

describe("auto-bootstrap satisfaction policy propagation", () => {
  it("forces presence on service-registered repair even when the source is a local build", async () => {
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");
    readHostInstallRecordMock.mockResolvedValue({ version: "2.0.0" });
    createServiceControllerMock.mockReturnValue(
      makeServiceController("not-installed"),
    );

    await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "presence" },
        recordVersionOverride: null,
      }),
    );
  });

  it("uses the source-derived exact policy only on the install branch", async () => {
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");
    readHostInstallRecordMock.mockResolvedValue(null);
    createServiceControllerMock.mockReturnValue(
      makeServiceController("not-installed"),
    );

    await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "login",
      onProgress: null,
    });

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "exact", version: config.version },
        recordVersionOverride: config.version,
      }),
    );
  });

  it("uses the source-derived implicit minimum for a configured registry install", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    createServiceControllerMock.mockReturnValue(
      makeServiceController("not-installed"),
    );

    await maybeAutoBootstrap({
      runtime: makeRuntime({}),
      trigger: "host-status",
      onProgress: null,
    });

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: {
          kind: "implicit-registry-minimum",
          version: "1.7.2",
        },
      }),
    );
  });
});
