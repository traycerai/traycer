/**
 * The epic session's reads, from inside a hosted chat tile.
 *
 * THE PROOF: `StableTileSurfaceHost` mounts the tile above every
 * `EpicSessionProvider`, so the session's host client reaches it only through
 * `HostedChatSurfaceContextBridge`. The task's hosts and its collaborators are
 * read through that client; without it they key on no host, never dispatch,
 * and a destroyed sandbox's chat reads as an offline one.
 *
 * The real bridge, a real `HostClient`, the real query client and the real
 * readers. `renderTile` is a probe calling those readers: the full `ChatTile`
 * needs a host runtime this suite does not stand up.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useTaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { handleHostIds } from "@/lib/registries/epic-session-registry";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { pane } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const EPIC_ID = "epic-hosted-task-hosts";
const VIEW_TAB_ID = "view-tab-hosted-task-hosts";
const PANE_ID = "pane-hosted-task-hosts";
const INSTANCE_ID = "chat-hosted-task-hosts";
const VIEWER_ID = "viewer-1";
const SANDBOX_HOST_ID = "host-sandbox-t1";
const SANDBOX_NAME = "e2e-sbx-t1";
const COLLABORATOR_NAME = "Collaborator One";

const SANDBOX_END: TaskSandboxEnd = {
  state: "destroyed",
  destroyedAt: Date.UTC(2026, 9, 28, 21, 29),
  cause: "resting",
  actor: null,
  idleMinutes: null,
};

const OPEN_EPIC_HANDLE = {} as OpenEpicStoreHandle;

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostProvider: (props: { readonly children: ReactNode }) =>
    props.children,
  BrowserOpenSessionsProvider: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/components/epic-canvas/renderers/tile-render", () => ({
  renderTile: (): ReactNode => <SessionReadsProbe />,
}));

/** What a hosted chat reads through the epic session's host. */
function SessionReadsProbe(): ReactNode {
  const task = useTaskSandboxHost(EPIC_ID, SANDBOX_HOST_ID);
  const collaborators = useEpicCollaboratorsQuery(EPIC_ID, {
    client: useEpicSessionHostClient(),
    enabled: true,
    poll: false,
    staleTime: undefined,
  }).data;
  return (
    <>
      <p data-testid="sandbox-line">
        {task.kind === "ended"
          ? taskSandboxEndLine(task.ended.name, task.ended.end, true)
          : `not ended: ${task.kind}`}
      </p>
      <ul data-testid="collaborators">
        {(collaborators?.flatRows ?? []).map((row) => (
          <li key={row.key}>{row.displayName}</li>
        ))}
      </ul>
    </>
  );
}

import { HostedChatSurfaceContextBridge } from "@/components/epic-canvas/surface-host/hosted-chat-surface-context-bridge";

/** A real requester whose task hosts name a destroyed sandbox. */
function createSessionHostClient(
  queryClient: QueryClient,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "hosted-task-hosts",
      handlers: {
        "epic.listTaskHosts": () => ({
          hosts: [
            {
              hostId: SANDBOX_HOST_ID,
              label: SANDBOX_NAME,
              principal: { kind: "user", id: VIEWER_ID },
              reach: "same_principal",
              sandboxEnd: SANDBOX_END,
            },
          ],
        }),
        "epic.listCollaborators": () => ({
          collaborators: [
            {
              role: "editor",
              accessType: "direct",
              environmentId: null,
              grantedAt: 1,
              grantedBy: VIEWER_ID,
              user: {
                userId: "collaborator-1",
                profile: {
                  displayName: COLLABORATOR_NAME,
                  avatarUrl: "",
                  email: "",
                  handle: "collaborator-one",
                },
              },
            },
          ],
          collaboratorsAvailable: true,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function seedChatTile(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: EPIC_ID, name: "Epic" },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        root: pane(PANE_ID, [INSTANCE_ID]),
        activePaneId: PANE_ID,
        tilesByInstanceId: {
          [INSTANCE_ID]: {
            id: INSTANCE_ID,
            instanceId: INSTANCE_ID,
            type: "chat",
            name: "Destroyed sandbox chat",
            hostId: SANDBOX_HOST_ID,
          },
        },
        sizesByGroupId: {},
      },
    },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
  });
}

/** The query keys `method` was filed under, each as the host it names. */
function hostSegmentsOf(queryClient: QueryClient, method: string): unknown[] {
  return queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => query.queryKey.includes(method) })
    .map((query) => (query.queryKey[1] === method ? null : query.queryKey[1]));
}

describe("a hosted chat tile reads through the epic session's host", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
    });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    seedChatTile();
    handleHostIds.set(OPEN_EPIC_HANDLE, mockLocalHostEntry.hostId);
  });

  afterEach(() => {
    cleanup();
    handleHostIds.delete(OPEN_EPIC_HANDLE);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("a destroyed sandbox's chat reads the task's end, and a shared task its collaborators", async () => {
    const queryClient = createAppQueryClient();
    const client = createSessionHostClient(queryClient);
    const environment = buildSyntheticTileSurfaceEnvironment(INSTANCE_ID, {
      placement: {
        epicId: EPIC_ID,
        viewTabId: VIEW_TAB_ID,
        paneId: PANE_ID,
        hostId: SANDBOX_HOST_ID,
      },
      services: {
        openEpicHandle: OPEN_EPIC_HANDLE,
        hostClient: client,
        geometryAnchorElement: document.createElement("div"),
        panePortalContainer: null,
        isPaneFocusedNow: () => false,
        mobileOpenTarget: null,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HostedChatSurfaceContextBridge environment={environment} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("sandbox-line").textContent).toBe(
        taskSandboxEndLine(SANDBOX_NAME, SANDBOX_END, true),
      );
    });
    expect(screen.getByTestId("sandbox-line").textContent).toContain(
      "after resting. Its files are gone; this chat stays readable.",
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId("collaborators").textContent).toBe(
        COLLABORATOR_NAME,
      );
    });
    // Both reads share the session host's entries the sidebar fills; none is
    // filed under no host.
    expect(hostSegmentsOf(queryClient, "epic.listTaskHosts")).toEqual([
      mockLocalHostEntry.hostId,
    ]);
    expect(hostSegmentsOf(queryClient, "epic.listCollaborators")).toEqual([
      mockLocalHostEntry.hostId,
    ]);
  });
});
