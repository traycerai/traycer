import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

const mocks = vi.hoisted(() => ({
  buildHostStreamClient: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  buildHostStreamClient: mocks.buildHostStreamClient,
}));

import { openOneShotStreamTransport } from "@/lib/host/one-shot-stream-transport";

// `buildHostStreamClient` is mocked in these tests, so `target` only needs to
// satisfy the type — its content plays no role in the assembly contract.
const FAKE_TARGET: HostDirectoryEntry = {
  hostId: "host-a",
  label: "host-a",
  kind: "local",
  websocketUrl: "ws://host-a/rpc",
  version: null,
  transportDialability: "dialable",
};

function buildParams() {
  return {
    target: FAKE_TARGET,
    userId: "user-a",
    endpoint: () => null,
    bearer: () => null,
    authnBaseUrl: "http://localhost:5005",
  };
}

beforeEach(() => {
  mocks.buildHostStreamClient.mockReset();
});

describe("openOneShotStreamTransport", () => {
  it("builds the transport with auth: null AND proactiveWakeEligible: false - both halves of the one-shot safety contract", () => {
    const fakeWs = { close: vi.fn() };
    mocks.buildHostStreamClient.mockReturnValue(fakeWs);

    const transport = openOneShotStreamTransport(buildParams());

    // Both fields pinned together: `auth: null` makes UNAUTHORIZED terminal,
    // and `proactiveWakeEligible: false` bars the process-wide sweep from
    // force-dropping a healthy mux whose reconnect would REPLAY the
    // destructive `worktree.deleteByPath` subscribe. Flipping either one
    // re-opens a real replay path, so this assertion must fail for either.
    expect(mocks.buildHostStreamClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: null, proactiveWakeEligible: false }),
    );
    expect(transport.wsStreamClient).toBe(fakeWs);

    transport.close();
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
  });

  it("throws an honest, cause-inclusive error when buildHostStreamClient returns null", () => {
    // Two refusals map to null: a corrupt registry public key, or the
    // transport bearer gate finding no presentable credential (this delete
    // racing a sign-out / context handoff). The error must not blame the key
    // for what may be an auth-transition race.
    mocks.buildHostStreamClient.mockReturnValue(null);

    expect(() => openOneShotStreamTransport(buildParams())).toThrow(
      /no valid public key or presentable credential/,
    );
  });
});
