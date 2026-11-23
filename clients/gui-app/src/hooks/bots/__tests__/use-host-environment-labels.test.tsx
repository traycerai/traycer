import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostReadResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostEnvironmentLabelResolver } from "@/hooks/bots/use-host-environment-labels";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "host-a";
const LABEL = "Acme platform";
const BINDING: EnvironmentHostReadResponseV11 = {
  hostId: HOST_ID,
  environment: {
    environmentId: "env-acme",
    ownerKind: "user",
    ownerId: "viewer",
    roomId: "room",
    label: LABEL,
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
  sharingGeneration: null,
};
const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    runtime.client === null
      ? null
      : {
          hostClient: runtime.client,
          hostId: undefined,
          directory: {
            getLocalHostId: () => null,
            onChange: () => ({ dispose: () => undefined }),
          },
        },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: [], resolved: true }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer",
}));

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {props.children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useHostEnvironmentLabelResolver", () => {
  it("labels a local-socket host on a runner with no local host id", async () => {
    const { spine } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
        "environment.host.read": () => BINDING,
      },
    });
    runtime.client = spine;

    const { result } = renderHook(
      () => useHostEnvironmentLabelResolver([HOST_ID], null),
      { wrapper },
    );

    await waitFor(() => expect(result.current(HOST_ID)).toBe(LABEL));
  });
});
