import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

const mocks = vi.hoisted(() => ({
  provisionHostMock: vi.fn(),
  resolveBundledHostArchiveMock: vi.fn(),
}));

vi.mock("../provision", () => ({
  provisionHost: mocks.provisionHostMock,
}));

vi.mock("../../installer/bundled-host", () => ({
  resolveBundledHostArchive: mocks.resolveBundledHostArchiveMock,
}));

const { provisionHostMock, resolveBundledHostArchiveMock } = mocks;

import { config } from "../../config";
import { ensureHost, type EnsureHostOptions } from "../ensure";

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
    beforeMutate: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  config.supportedHostVersion = null;
  resolveBundledHostArchiveMock.mockResolvedValue(null);
  provisionHostMock.mockResolvedValue(makeResult());
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
