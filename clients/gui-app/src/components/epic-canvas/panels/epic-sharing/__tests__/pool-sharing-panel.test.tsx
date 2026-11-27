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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  poolCollaborator,
  poolCollaboratorsResponse,
} from "@/lib/history-composition/test-support/history-wire-fixtures";

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicPermissionRole: () => "owner",
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const EPIC_ID = "synthetic-pool-sharing-task";
const VIEWER_ID = "synthetic-pool-sharing-viewer";
const OTHER_ID = "synthetic-pool-sharing-other";
const TEAM_ID = "synthetic-pool-sharing-team";

it.each(["role", "grant", "revoke"] as const)(
  "keeps a %s result after its independent old pool read arrives first",
  async (operation) => {
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
      [{ teamId: TEAM_ID, slug: "Synthetic Shared Team", avatarUrl: null }],
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
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
    const initial = poolCollaboratorsResponse(
      [own, other, remainingOwner],
      true,
    );
    const roleResult = poolCollaboratorsResponse(
      [own, { ...other, role: "editor" }, remainingOwner],
      true,
    );
    const grantResult = poolCollaboratorsResponse(
      [
        own,
        other,
        remainingOwner,
        {
          role: "editor",
          accessType: "organization",
          environmentId: null,
          grantedAt: 1,
          grantedBy: VIEWER_ID,
          team: {
            teamId: TEAM_ID,
            teamName: "Synthetic Shared Team",
            teamMembers: [
              {
                userId: OTHER_ID,
                profile: {
                  displayName: "Synthetic Teammate",
                  handle: OTHER_ID,
                  email: "teammate@example.invalid",
                  avatarUrl: "",
                },
              },
            ],
          },
        },
      ],
      true,
    );
    const revokeResult = poolCollaboratorsResponse([], false);
    const oldRead = Promise.withResolvers<ListEpicCollaboratorsResponse>();
    const oldReadStarted = Promise.withResolvers<void>();
    const mutationResult =
      Promise.withResolvers<ListEpicCollaboratorsResponse>();
    const mutationStarted = Promise.withResolvers<void>();
    let reads = 0;
    const mutationMethod = {
      role: "epic.batchUpdateRoles",
      grant: "epic.grantAccess",
      revoke: "epic.revokeCollaborator",
    }[operation];
    const resultByOperation = {
      role: roleResult,
      grant: grantResult,
      revoke: revokeResult,
    }[operation];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => `pool-sharing-${operation}-early-read`,
      handlers: {
        "epic.listCollaborators": () => {
          reads++;
          if (reads === 1) return initial;
          if (reads === 2) {
            oldReadStarted.resolve();
            return oldRead.promise;
          }
          throw new Error("Unexpected extra Sharing list request");
        },
        "epic.batchUpdateRoles": () => {
          if (operation !== "role") throw new Error("Unexpected role mutation");
          mutationStarted.resolve();
          return mutationResult.promise;
        },
        "epic.grantAccess": () => {
          if (operation !== "grant")
            throw new Error("Unexpected grant mutation");
          mutationStarted.resolve();
          return mutationResult.promise;
        },
        "epic.revokeCollaborator": () => {
          if (operation !== "revoke")
            throw new Error("Unexpected revoke mutation");
          mutationStarted.resolve();
          return mutationResult.promise;
        },
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
    const cacheKey = epicCollaboratorsQueryKey(
      poolEntry.hostId,
      EPIC_ID,
      VIEWER_ID,
    );

    try {
      await waitFor(() =>
        expect(queryClient.getQueryData(cacheKey)).toEqual(initial),
      );
      fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));
      await oldReadStarted.promise;

      if (operation === "role") {
        const roleButton = await screen.findByRole("button", {
          name: "Change role for Synthetic Teammate",
        });
        fireEvent.keyDown(roleButton, { key: "Enter" });
        fireEvent.click(
          await screen.findByRole("menuitemradio", { name: "Editor" }),
        );
      } else if (operation === "grant") {
        fireEvent.click(screen.getByTestId("team-share-button"));
        await screen.findByText("Synthetic Shared Team");
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "Remove Synthetic Owner" }),
        );
        fireEvent.click(screen.getByTestId("confirm-action"));
      }
      await mutationStarted.promise;
      expect(
        messenger.calls.find((call) => call.method === mutationMethod),
      ).toMatchObject({
        authority: { endpoint: { hostId: poolEntry.hostId } },
      });

      await act(async () => {
        oldRead.resolve(initial);
        await oldRead.promise;
      });
      await waitFor(() =>
        expect(queryClient.getQueryState(cacheKey)?.fetchStatus).toBe("idle"),
      );
      expect(queryClient.getQueryState(cacheKey)?.error).toBeNull();

      await act(async () => {
        mutationResult.resolve(resultByOperation);
        await mutationResult.promise;
      });
      await waitFor(() =>
        expect(queryClient.getQueryData(cacheKey)).toEqual(resultByOperation),
      );
      expect(queryClient.getQueryState(cacheKey)?.error).toBeNull();
      expect(reads).toBe(2);
    } finally {
      oldRead.resolve(initial);
      mutationResult.resolve(resultByOperation);
      view.unmount();
      queryClient.clear();
      following.dispose();
      useAuthStore.setState({ status: "signed-out" });
    }
  },
);

it("discards each held pool Sharing read after its grant, role, or revoke settles", async () => {
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
    [{ teamId: TEAM_ID, slug: "Synthetic Shared Team", avatarUrl: null }],
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
  const granted = poolCollaboratorsResponse(
    [
      own,
      { ...other, role: "editor" },
      remainingOwner,
      {
        role: "editor",
        accessType: "organization",
        environmentId: null,
        grantedAt: 1,
        grantedBy: VIEWER_ID,
        team: {
          teamId: TEAM_ID,
          teamName: "Synthetic Shared Team",
          teamMembers: [
            {
              userId: OTHER_ID,
              profile: {
                displayName: "Synthetic Teammate",
                handle: OTHER_ID,
                email: "teammate@example.invalid",
                avatarUrl: "",
              },
            },
          ],
        },
      },
    ],
    true,
  );
  const unavailable = poolCollaboratorsResponse([], false);
  const roleRead = Promise.withResolvers<ListEpicCollaboratorsResponse>();
  const roleReadStarted = Promise.withResolvers<void>();
  const grantRead = Promise.withResolvers<ListEpicCollaboratorsResponse>();
  const grantReadStarted = Promise.withResolvers<void>();
  const revokeRead = Promise.withResolvers<ListEpicCollaboratorsResponse>();
  const revokeReadStarted = Promise.withResolvers<void>();
  let reads = 0;
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => "pool-sharing-panel-test",
    handlers: {
      "epic.listCollaborators": () => {
        reads++;
        if (reads === 1) return initial;
        if (reads === 2) {
          roleReadStarted.resolve();
          return roleRead.promise;
        }
        if (reads === 3) {
          grantReadStarted.resolve();
          return grantRead.promise;
        }
        if (reads === 4) {
          revokeReadStarted.resolve();
          return revokeRead.promise;
        }
        throw new Error(
          "The revoked session attempted another collaborator read",
        );
      },
      "epic.batchUpdateRoles": () => changed,
      "epic.grantAccess": () => granted,
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
    fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));
    await roleReadStarted.promise;
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
    expect(queryClient.getQueryData(cacheKey)).toEqual(changed);
    await act(async () => {
      roleRead.resolve(initial);
      await roleRead.promise;
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(cacheKey)).toEqual(changed),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("epic-sharing-refresh-button")
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));
    await grantReadStarted.promise;
    fireEvent.click(screen.getByTestId("team-share-button"));
    await screen.findByText("Synthetic Shared Team");
    await waitFor(() =>
      expect(queryClient.getQueryData(cacheKey)).toEqual(granted),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Shared with Synthetic Shared Team",
    );
    await act(async () => {
      grantRead.resolve(changed);
      await grantRead.promise;
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(cacheKey)).toEqual(granted),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("epic-sharing-refresh-button")
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));
    await revokeReadStarted.promise;
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
      revokeRead.resolve(granted);
      await revokeRead.promise;
    });
    expect(queryClient.getQueryData(cacheKey)).toEqual(unavailable);
    expect(queryClient.getQueryState(cacheKey)?.error).toBeNull();
    expect(errors).toEqual([]);
    expect(screen.queryByText("Synthetic Owner")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(reads).toBe(4);
    expect(
      messenger.calls
        .filter(
          ({ method }) =>
            method === "epic.batchUpdateRoles" ||
            method === "epic.grantAccess" ||
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
        method: "epic.grantAccess",
        hostId: poolEntry.hostId,
        params: {
          epicId: EPIC_ID,
          input: {
            kind: "team",
            teamId: TEAM_ID,
            role: "editor",
          },
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
    roleRead.resolve(initial);
    grantRead.resolve(changed);
    revokeRead.resolve(granted);
    stopObserving();
    view.unmount();
    queryClient.clear();
    following.dispose();
    useAuthStore.setState({ status: "signed-out" });
  }
});

it("keeps a queued invitation after the pool returns an unknown RPC_ERROR", async () => {
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
  const initial = poolCollaboratorsResponse(
    [
      poolCollaborator(VIEWER_ID, "Synthetic Owner", "owner", VIEWER_ID),
      poolCollaborator(
        "synthetic-sharing-remaining-owner",
        "Synthetic Remaining Owner",
        "owner",
        VIEWER_ID,
      ),
    ],
    true,
  );
  const requestId = "pool-sharing-unknown-invite";
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => requestId,
    handlers: {
      "epic.listCollaborators": () => initial,
      "epic.grantAccess": () => {
        throw new HostRpcError({
          code: "RPC_ERROR",
          requestId,
          method: "epic.grantAccess",
          message: "epic.grantAccess is unavailable right now",
          fatalDetails: null,
        });
      },
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
  try {
    await screen.findByText("Synthetic Remaining Owner");
    fireEvent.change(screen.getByLabelText("Email or GitHub handle"), {
      target: { value: "pending@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("invite-add-button"));
    expect(screen.getByTestId("invite-queue").textContent).toContain(
      "pending@example.invalid",
    );
    fireEvent.click(screen.getByTestId("invite-send-button"));

    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.grantAccess"),
      ).toMatchObject({
        authority: { endpoint: { hostId: poolEntry.hostId } },
        params: {
          epicId: EPIC_ID,
          input: {
            kind: "users",
            invites: [
              {
                identifier: "pending@example.invalid",
                identifierType: "email",
                role: "editor",
              },
            ],
          },
        },
      });
      expect(screen.getByTestId("invite-queue").textContent).toContain(
        "pending@example.invalid",
      );
    });
    const { toast } = await import("sonner");
    expect(toast).toHaveBeenCalledWith(
      "No reply came back from the Traycer host, so this may or may not have gone through.",
      expect.any(Object),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't invite pending@example.invalid"),
      expect.anything(),
    );
  } finally {
    view.unmount();
    queryClient.clear();
    following.dispose();
    useAuthStore.setState({ status: "signed-out" });
  }
});

it("presents a marked TASK_READ_UNAVAILABLE as unknown and reconciles only pool Sharing", async () => {
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
  const notifications = useAppLocalNotificationsStore;
  notifications.getState().resetForTests();
  notifications.getState().activateIdentity(VIEWER_ID);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const initial = poolCollaboratorsResponse(
    [
      poolCollaborator(VIEWER_ID, "Synthetic Owner", "owner", VIEWER_ID),
      poolCollaborator(OTHER_ID, "Synthetic Teammate", "editor", VIEWER_ID),
      poolCollaborator(
        "synthetic-sharing-remaining-owner",
        "Synthetic Remaining Owner",
        "owner",
        VIEWER_ID,
      ),
    ],
    true,
  );
  let reads = 0;
  const requestId = "pool-sharing-task-read-unavailable";
  const fatalReason = "TASK_READ_UNAVAILABLE: task read is no longer current";
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => requestId,
    handlers: {
      "epic.listCollaborators": () => {
        reads++;
        return initial;
      },
      "epic.revokeCollaborator": () => {
        const error = new HostRpcError({
          code: "RPC_ERROR",
          requestId,
          method: "epic.revokeCollaborator",
          message: fatalReason,
          fatalDetails: {
            code: "TASK_READ_UNAVAILABLE",
            reason: fatalReason,
            retryable: true,
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        });
        markMayHaveReachedHost(error);
        throw error;
      },
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
  const cacheKey = epicCollaboratorsQueryKey(
    poolEntry.hostId,
    EPIC_ID,
    VIEWER_ID,
  );
  try {
    await screen.findByText("Synthetic Teammate");
    expect(reads).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Synthetic Teammate" }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(
        messenger.calls.find(
          (call) => call.method === "epic.revokeCollaborator",
        ),
      ).toMatchObject({
        authority: { endpoint: { hostId: poolEntry.hostId } },
        params: {
          epicId: EPIC_ID,
          input: { kind: "users", userId: OTHER_ID },
        },
      });
      expect(reads).toBe(2);
    });

    const { toast } = await import("sonner");
    expect(toast).toHaveBeenCalledWith(
      "No reply came back from the Traycer host, so this may or may not have gone through.",
      expect.any(Object),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(cacheKey)).toEqual(initial);
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.listCollaborators")
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([poolEntry.hostId, poolEntry.hostId]);
    expect(notifications.getState().orderedIds).toEqual([]);
    expect(Object.keys(notifications.getState().byId)).toEqual([]);
    expect(screen.queryByText(fatalReason)).toBeNull();
  } finally {
    view.unmount();
    queryClient.clear();
    following.dispose();
    notifications.getState().resetForTests();
    useAuthStore.setState({ status: "signed-out" });
  }
});
