import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { epicCollaboratorsQueryKey } from "@/hooks/epics/epic-collaborators-query-key";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import { EpicSessionHostClientContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SharingPanel } from "../panel";
import {
  poolCollaborator,
  poolCollaboratorsResponse,
} from "@/lib/history-composition/test-support/history-wire-fixtures";

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicPermissionRole: () => "owner",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const EPIC_ID = "synthetic-pool-sharing-task";
const VIEWER_ID = "synthetic-pool-sharing-viewer";
const OTHER_ID = "synthetic-pool-sharing-other";

it("changes a pool Sharing role and discards a held collaborator read after self-removal", async () => {
  const selection = mountTestSelectionAuthority({
    hosts: [],
    readyComputers: [],
    pool: "ready",
  });
  expect(selection.snapshot().servingPeer).toEqual({ kind: "pool" });
  useAuthStore.getState().setSignedIn(
    {
      userId: VIEWER_ID,
      userName: "Synthetic Owner",
      email: "owner@example.invalid",
    },
    { userId: VIEWER_ID, username: "Synthetic Owner" },
    [],
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const own = poolCollaborator(
    VIEWER_ID,
    "Synthetic Owner",
    "owner",
    VIEWER_ID,
  );
  const other = poolCollaborator(
    OTHER_ID,
    "Synthetic Teammate",
    "owner",
    VIEWER_ID,
  );
  const remainingOwner = poolCollaborator(
    "synthetic-pool-sharing-remaining",
    "Synthetic Remaining Owner",
    "owner",
    VIEWER_ID,
  );
  const initial = poolCollaboratorsResponse([own, other, remainingOwner], true);
  const changed = poolCollaboratorsResponse(
    [own, { ...other, role: "editor" }, remainingOwner],
    true,
  );
  const unavailable = poolCollaboratorsResponse([], false);
  const pending = Promise.withResolvers<ListEpicCollaboratorsResponse>();
  const refreshStarted = Promise.withResolvers<void>();
  let reads = 0;
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => "pool-sharing-panel-test",
    handlers: {
      "epic.listCollaborators": () => {
        reads++;
        if (reads === 1) return initial;
        if (reads === 2) {
          refreshStarted.resolve();
          return pending.promise;
        }
        throw new Error(
          "The revoked session attempted another collaborator read",
        );
      },
      "epic.batchUpdateRoles": () => changed,
      "epic.revokeCollaborator": () => unavailable,
    },
  });
  const following = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (id) => (id === poolEntry.hostId ? poolEntry : null),
    messenger,
    routing: {
      plan: createHostRpcTierPlan(poolEntry),
      selectedHostId: () => null,
      serving: () => ({
        servingPeer: poolEntry,
        servingPeerMethods: null,
        servingPeerEnvironmentId: null,
      }),
    },
  });
  following.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-sharing-bearer",
      identity: {
        userId: VIEWER_ID,
        username: "Synthetic Owner",
        providerHandle: "synthetic-owner",
      },
    }),
  );
  const client = following.createRequesterForHostId(poolEntry.hostId);
  const view = render(
    <EpicSessionHostClientContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SharingPanel epicId={EPIC_ID} />
        </TooltipProvider>
      </QueryClientProvider>
    </EpicSessionHostClientContext.Provider>,
  );
  const errors: unknown[] = [];
  const stopObserving = queryClient.getQueryCache().subscribe(({ query }) => {
    if (query.state.error !== null) errors.push(query.state.error);
  });
  try {
    const cacheKey = epicCollaboratorsQueryKey(
      poolEntry.hostId,
      EPIC_ID,
      VIEWER_ID,
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(cacheKey)).toMatchObject({
        status: "success",
      }),
    );
    const role = await screen.findByRole("button", {
      name: "Change role for Synthetic Teammate",
    });
    fireEvent.keyDown(role, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Editor" }),
    );
    const teammate = screen.getByText("Synthetic Teammate").closest("li");
    if (teammate === null)
      throw new Error("The sharing list did not render the teammate");
    await within(teammate).findByText("Editor");
    fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));
    await refreshStarted.promise;
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Synthetic Owner" }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(queryClient.getQueryData(cacheKey)).toEqual(unavailable);
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(toast.success).toHaveBeenCalledWith("Collaborator removed");
    await act(async () => {
      pending.resolve(changed);
      await pending.promise;
    });
    expect(queryClient.getQueryData(cacheKey)).toEqual(unavailable);
    expect(queryClient.getQueryState(cacheKey)?.error).toBeNull();
    expect(errors).toEqual([]);
    expect(screen.queryByText("Synthetic Owner")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    expect(
      messenger.calls
        .filter(
          ({ method }) =>
            method === "epic.batchUpdateRoles" ||
            method === "epic.revokeCollaborator",
        )
        .map(({ method, authority, params }) => ({
          method,
          hostId: authority.endpoint.hostId,
          params,
        })),
    ).toEqual([
      {
        method: "epic.batchUpdateRoles",
        hostId: poolEntry.hostId,
        params: {
          epicId: EPIC_ID,
          input: { changes: [{ userId: OTHER_ID, newRole: "editor" }] },
        },
      },
      {
        method: "epic.revokeCollaborator",
        hostId: poolEntry.hostId,
        params: {
          epicId: EPIC_ID,
          input: { kind: "users", userId: VIEWER_ID },
        },
      },
    ]);
  } finally {
    pending.resolve(changed);
    stopObserving();
    view.unmount();
    queryClient.clear();
    following.dispose();
    useAuthStore.setState({ status: "signed-out" });
  }
});
