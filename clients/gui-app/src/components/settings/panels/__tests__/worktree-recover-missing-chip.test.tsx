import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ConfigWorktreesSetRequest } from "@traycer/protocol/host/config/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The missing-folders chip. The RPCs run for real against a `MockHostMessenger`;
 * only the negotiated version per method (a per-host fact the chip cannot
 * synthesize) is mocked.
 */
const negotiated = vi.hoisted(
  (): { get: NegotiatedMethodVersion; set: NegotiatedMethodVersion } => ({
    get: null,
    set: null,
  }),
);

const reachability = vi.hoisted(
  (): { status: "reachable" | "offline" | "host-starting" } => ({
    status: "reachable",
  }),
);

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: () => ({
    status: reachability.status,
    hostLabel: "Host A",
  }),
}));

vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: (_client: unknown, method: string) =>
    method === "config.worktrees.set" ? negotiated.set : negotiated.get,
}));

import { WorktreeRecoverMissingChip } from "@/components/settings/panels/worktree-recover-missing-chip";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";

function createHarness(initial: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let stored = initial;
  let gets = 0;
  const sets: ConfigWorktreesSetRequest[] = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "config.worktrees.get": () => {
          gets += 1;
          return { agentCreate: "allow", recoverMissing: stored };
        },
        "config.worktrees.set": (params) => {
          sets.push(params);
          if (params.recoverMissing !== null) stored = params.recoverMissing;
          return { agentCreate: "allow", recoverMissing: stored };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <WorktreeRecoverMissingChip
      scope={hostScopeFixture({
        host: hostScopeOptionFixture({ hostId: "host-a", name: "Host A" }),
        client,
      })}
    />,
    { wrapper: Wrapper },
  );
  return { sets: () => sets, gets: () => gets };
}

beforeEach(() => {
  reachability.status = "reachable";
  negotiated.get = { major: 1, minor: 1 };
  negotiated.set = { major: 1, minor: 1 };
});

afterEach(() => {
  cleanup();
});

describe("WorktreeRecoverMissingChip", () => {
  it("renders nothing for a host that negotiated only 1.0", () => {
    negotiated.get = { major: 1, minor: 0 };
    negotiated.set = { major: 1, minor: 0 };
    createHarness(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when only one of the two methods reached 1.1", () => {
    negotiated.set = { major: 1, minor: 0 };
    createHarness(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // A host seen on 1.1 keeps its negotiated versions while it is offline or
  // starting; reading the setting then would report the failure as a broken
  // config file.
  it("renders nothing and reads nothing while a 1.1 host is offline or starting", () => {
    for (const status of ["offline", "host-starting"] as const) {
      reachability.status = status;
      const harness = createHarness(true);
      expect(screen.queryByRole("button")).toBeNull();
      expect(harness.gets()).toBe(0);
      cleanup();
    }
  });

  it("states Recover when the host answers recoverMissing true", async () => {
    createHarness(true);
    const trigger = await screen.findByRole("button", {
      name: "Missing folders setting",
    });
    await waitFor(() => {
      expect(trigger.textContent).toBe("Missing folders · Recover");
    });
  });

  it("writes only recoverMissing when Stop is chosen", async () => {
    const harness = createHarness(true);
    const trigger = await screen.findByRole("button", {
      name: "Missing folders setting",
    });
    await waitFor(() => {
      expect(trigger.textContent).toBe("Missing folders · Recover");
    });
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const stop = await screen.findByRole("menuitemradio", { name: /^Stop/ });
    await waitFor(() => {
      expect(stop.getAttribute("aria-disabled")).not.toBe("true");
    });
    fireEvent.click(stop);

    await waitFor(() => {
      expect(harness.sets()).toEqual([
        { agentCreate: null, recoverMissing: false },
      ]);
    });
    await waitFor(() => {
      expect(trigger.textContent).toBe("Missing folders · Stop");
    });
  });
});
