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
    keepInstalled: false,
    onProgress: null,
    adoption: undefined,
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

  // Q7: `exact` for an own build is what silently reverted a host the user had
  // updated out of band - the desktop asks for a convergence whenever the local
  // host is down or has not been dialed, and equality could not say "newer is
  // fine". `own-build-minimum` keeps a comparably newer install and converges
  // everything else, `recordVersionOverride` is unchanged, and `--release` (the
  // row above) keeps `exact` because a pin is a pin.
  it("passes own-build-minimum against the CLI build for local-file sources", async () => {
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");

    await ensureHost(makeEnsureOptions({}));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "own-build-minimum", version: config.version },
        recordVersionOverride: config.version,
      }),
    );
  });

  // The Windows desktop reaches the SAME bundled archive through `--from`
  // (`resolveWindowsBundledHostArchive`), so this row is not a courtesy: on the
  // old mapping the two desktop platforms would disagree about whether a user's
  // newer host survives a convergence.
  it("passes own-build-minimum against the CLI build for explicit --from sources", async () => {
    await ensureHost(makeEnsureOptions({ fromPath: "/tmp/host.tar.gz" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveInstallSource: expect.any(Function),
        satisfaction: { kind: "own-build-minimum", version: config.version },
        recordVersionOverride: config.version,
      }),
    );
    await expect(
      provisionHostMock.mock.calls[0]?.[0].resolveInstallSource(),
    ).resolves.toEqual({ kind: "local-file", path: "/tmp/host.tar.gz" });
  });

  // Ticket 2: `--keep-installed` selects the liveness-only `viability`
  // policy, but only for the IMPLICIT convergence - an explicit `--release`
  // still wins as `exact`, and `keepInstalled` alone (no version, no
  // `--from`) selects `viability`.
  it("passes viability for --keep-installed with no explicit version", async () => {
    await ensureHost(makeEnsureOptions({ keepInstalled: true }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ satisfaction: { kind: "viability" } }),
    );
  });

  it("keeps exact for --keep-installed --release X - a named version still wins", async () => {
    await ensureHost(
      makeEnsureOptions({ keepInstalled: true, versionRequest: "1.6.0" }),
    );

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        satisfaction: { kind: "exact", version: "1.6.0" },
      }),
    );
  });

  // Deliberately NOT gated on `fromPath === null`: the Windows desktop's
  // CLI-owned background route passes `--from <bundled archive>` as the
  // FIRST-INSTALL source, not as an explicit version pin, so `--keep-installed`
  // must still select `viability` here rather than falling through to
  // `own-build-minimum`.
  it("passes viability for --keep-installed --from <archive> (the Windows CLI-owned background route)", async () => {
    await ensureHost(
      makeEnsureOptions({
        keepInstalled: true,
        fromPath: "/bundle/host.tar.gz",
      }),
    );

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ satisfaction: { kind: "viability" } }),
    );
  });
});

// Final hold model: the SET itself (strict-downgrade comparison, atomic
// write) is covered by `provision.test.ts`'s `holdVersionIfDowngrade` rows.
// This block only pins `ensure.ts`'s WIRING - whether it asks provisionHost
// to hold at all - since that boolean is the one thing this layer decides.
describe("ensureHost holdExplicitDowngrade propagation", () => {
  it("passes true for an explicit --release pin (a deliberate downgrade must be holdable)", async () => {
    await ensureHost(makeEnsureOptions({ versionRequest: "1.6.0" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ holdExplicitDowngrade: true }),
    );
  });

  it("passes true for --keep-installed --release X - a named version still holds", async () => {
    await ensureHost(
      makeEnsureOptions({ keepInstalled: true, versionRequest: "1.6.0" }),
    );

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ holdExplicitDowngrade: true }),
    );
  });

  it("passes false for a background/implicit convergence with no explicit version", async () => {
    await ensureHost(makeEnsureOptions({}));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ holdExplicitDowngrade: false }),
    );
  });

  it("passes false for --keep-installed with no explicit version", async () => {
    await ensureHost(makeEnsureOptions({ keepInstalled: true }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ holdExplicitDowngrade: false }),
    );
  });

  it("passes false for --release latest - not a deliberate pin to an older version", async () => {
    await ensureHost(makeEnsureOptions({ versionRequest: "latest" }));

    expect(provisionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ holdExplicitDowngrade: false }),
    );
  });
});
