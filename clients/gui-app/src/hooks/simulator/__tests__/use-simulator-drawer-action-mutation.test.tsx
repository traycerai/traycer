import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SimulatorDetail } from "@traycer/protocol/host/simulator/actions";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * The settings drawer's action and the detail read beside it. A send that
 * ANSWERS is itself the fresh read and replaces the cached detail; a send
 * that does not may still have been taken, so the drawer asks the host again
 * rather than printing an error next to the value from before the send.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-drawer-1";
const UDID = "udid-1";

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

import {
  useSimulatorDetailQuery,
  useSimulatorDrawerActionMutation,
} from "@/hooks/simulator/use-simulator-mutations";

function detail(appearance: "light" | "dark"): SimulatorDetail {
  return {
    simulatorId: UDID,
    platform: "ios",
    settings: {
      appearance,
      textSize: "default",
      reduceMotion: false,
      increaseContrast: false,
      reduceTransparency: false,
      showBorders: false,
      voiceOver: false,
      liquidGlass: "clear",
      colorFilter: "none",
      networkEnabled: null,
      location: null,
    },
    foregroundApp: null,
    readAt: "2026-10-29T00:00:00.000Z",
  };
}

/** The host's own appearance, and whether it answers the action at all. */
const host = { appearance: "light" as "light" | "dark", answers: true };

function buildRequester(): {
  readonly requester: HostClient<HostRpcRegistry>;
  readonly detailReads: () => number;
} {
  let detailReads = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "simulator-drawer-req",
    handlers: {
      "simulator.detail": () => {
        detailReads += 1;
        return detail(host.appearance);
      },
      "simulator.action": (params) => {
        // The host takes the action and then fails to say so: the appearance
        // has moved whatever the caller hears back.
        if (params.action.type === "setAppearance")
          host.appearance = params.action.value;
        if (!host.answers) throw new Error("The host did not answer in time.");
        return detail(host.appearance);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) =>
      hostId === HOST_ID ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-simulator-drawer",
    }),
  );
  return {
    requester: spine.createRequester(mockLocalHostEntry),
    detailReads: () => detailReads,
  };
}

/** The production client, for its real 60 s `staleTime`. */
function wrapper(): (props: { children: ReactNode }) => JSX.Element {
  const queryClient = createAppQueryClient();
  return function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function renderDrawerHooks(requester: HostClient<HostRpcRegistry>) {
  return renderHook(
    () => ({
      detail: useSimulatorDetailQuery(requester, HOST_ID, EPIC_ID, UDID),
      action: useSimulatorDrawerActionMutation(requester, HOST_ID, UDID)
        .mutation,
    }),
    { wrapper: wrapper() },
  );
}

afterEach(() => {
  cleanup();
  host.appearance = "light";
  host.answers = true;
  vi.clearAllMocks();
});

describe("useSimulatorDrawerActionMutation", () => {
  it("files an answered action as the detail, with no second read", async () => {
    const { requester, detailReads } = buildRequester();
    const { result } = renderDrawerHooks(requester);
    await waitFor(() => {
      expect(result.current.detail.data?.settings.appearance).toBe("light");
    });
    expect(detailReads()).toBe(1);

    act(() => {
      result.current.action.mutate({
        epicId: EPIC_ID,
        simulatorId: UDID,
        action: { type: "setAppearance", value: "dark" },
      });
    });

    await waitFor(() => {
      expect(result.current.detail.data?.settings.appearance).toBe("dark");
    });
    expect(detailReads()).toBe(1);
  });

  it("asks for the detail again when the action does not answer, inside the 60 s freshness window", async () => {
    host.answers = false;
    const { requester, detailReads } = buildRequester();
    const { result } = renderDrawerHooks(requester);
    await waitFor(() => {
      expect(result.current.detail.data?.settings.appearance).toBe("light");
    });
    expect(detailReads()).toBe(1);

    act(() => {
      result.current.action.mutate({
        epicId: EPIC_ID,
        simulatorId: UDID,
        action: { type: "setAppearance", value: "dark" },
      });
    });
    await waitFor(() => {
      expect(result.current.action.isError).toBe(true);
    });

    // The host took it: the cached detail is wrong, and nothing else would
    // ever move it - the read does not poll and its window is 60 s.
    await waitFor(() => {
      expect(result.current.detail.data?.settings.appearance).toBe("dark");
    });
    expect(detailReads()).toBe(2);
  });
});
