import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AvailabilityRecoveryKind } from "@traycer-clients/shared/host-transport/availability-recovery-kind";

// The subject is the opener's own recovery closure: which host it names, and
// that the kind the transport reported reaches `HostClient` untouched. Every
// module the opener imports is replaced whole, so none of their real graphs
// load: the hooks are stand-ins, and the transport it opens is captured rather
// than built. The opener reads nothing else from them.
const mocks = vi.hoisted(() => {
  const notifyHostAvailabilityRecovered = vi.fn();
  return {
    openDurableStreamTransport: vi.fn(),
    notifyHostAvailabilityRecovered,
    globalClient: {
      getRequestContextUserId: () => "user-a",
      getRequestContext: () => null,
      onBearerRotated: () => () => undefined,
      onCloudVerdictChanged: () => () => undefined,
      notifyHostAvailabilityRecovered,
    },
    directory: {
      findById: (hostId: string) => ({
        hostId,
        label: hostId,
        kind: "local",
        websocketUrl: `ws://${hostId}/rpc`,
        version: null,
        transportDialability: "dialable",
      }),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
});

// The setup file (`__tests__/test-browser-apis.ts`) replaces this very module
// with a fake opener for every jsdom suite, so a suite about the real opener
// has to take it back.
vi.unmock("@/lib/host/use-durable-stream-transport");
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.globalClient,
  useHostDirectory: () => mocks.directory,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => null,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => ({
    revalidateForReconnect: () => Promise.resolve("rotated"),
  }),
}));
vi.mock("@/lib/host/transport-key", () => ({
  dialableHostEndpoint: () => null,
}));
vi.mock("@/lib/host/durable-stream-transport", () => ({
  openDurableStreamTransport: mocks.openDurableStreamTransport,
}));

import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";

describe("useDurableStreamTransportFactory", () => {
  it("routes a transport's recovery to the host it was opened for, with the kind the transport reported", () => {
    const captured: {
      notify: ((kind: AvailabilityRecoveryKind) => void) | null;
    } = { notify: null };
    mocks.openDurableStreamTransport.mockImplementation(
      (params: {
        readonly notifyRecoveredForNamedHost: (
          kind: AvailabilityRecoveryKind,
        ) => void;
      }) => {
        captured.notify = params.notifyRecoveredForNamedHost;
        return {
          wsStreamClient: null,
          close: () => undefined,
          closeWithReason: () => undefined,
        };
      },
    );
    const { result } = renderHook(() => useDurableStreamTransportFactory());

    result.current("host-a");
    expect(mocks.openDurableStreamTransport).toHaveBeenCalledTimes(1);
    if (captured.notify === null) {
      throw new Error("the opener never opened a transport");
    }
    captured.notify("stall");
    captured.notify("reconnect");

    // Its own host every time - a tab's queries are keyed by the host it is
    // pinned to - and each kind as the transport reported it. A stall
    // forwarded as a reconnect would re-ask every settled read on the host.
    expect(mocks.notifyHostAvailabilityRecovered.mock.calls).toEqual([
      ["host-a", "stall"],
      ["host-a", "reconnect"],
    ]);
  });
});
