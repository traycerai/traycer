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
  status: "available",
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
  it("builds the transport with auth: null so an UNAUTHORIZED rejection is terminal", () => {
    const fakeWs = { close: vi.fn() };
    mocks.buildHostStreamClient.mockReturnValue(fakeWs);

    const transport = openOneShotStreamTransport(buildParams());

    expect(mocks.buildHostStreamClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: null }),
    );
    expect(transport.wsStreamClient).toBe(fakeWs);

    transport.close();
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
  });

  it("throws when buildHostStreamClient returns null (invalid remote public key)", () => {
    mocks.buildHostStreamClient.mockReturnValue(null);

    expect(() => openOneShotStreamTransport(buildParams())).toThrow(
      /invalid public key/,
    );
  });
});
