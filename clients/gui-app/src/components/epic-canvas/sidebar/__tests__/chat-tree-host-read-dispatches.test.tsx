/**
 * The task's shared host reads under a windowed chat tree, when the host
 * refuses them.
 *
 * THE PROOF: a refused `epic.listCollaborators` or `epic.listTaskHosts` holds
 * no data, and TanStack asks again for every observer that mounts onto a key
 * with no data. The windowed tree mounts rows as it scrolls - a local row's
 * card reads the task's hosts, a cloud row its owner's name - so a row that
 * read either key through an observer of its own would ask the host once per
 * row mounted, and each refusal would re-render the panel and every row that
 * reads it. The rows read the panel's answer instead: scrolling across the
 * list asks the host nothing more and costs the panel and the rows exactly
 * the renders it costs when the host answers. Each read reaches its readers
 * on its own, so a change to one leaves the other's readers alone.
 *
 * The real `ChatTreePanelBody` over a real epic store, a real `HostClient` and
 * the real `useTaskHostsView` and `useEpicCollaboratorsQuery`; the seams
 * replaced are the ones `chat-tree-task-hosts-refusal.test.tsx` replaces.
 */
import { act, cleanup, render } from "@testing-library/react";
import {
  QueryClientProvider,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
import type { FlattenChatTreeRowsInput } from "@/components/epic-canvas/sidebar/chat-tree-rows";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { setCloudChats } from "./chat-tree-host-mocks";
import { cloudSummary } from "./chat-tree-row-fixtures";
import {
  EPIC_ID,
  TAB_ID,
  openChatSession,
  rootChats,
} from "./chat-tree-test-support";

vi.mock("@tanstack/react-virtual", async (importOriginal) =>
  (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
    importOriginal,
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostClientForHostIdMock(
    importOriginal,
  ),
);
vi.mock(
  "@/hooks/pr/use-owner-pr-references",
  async () => (await import("./chat-tree-host-mocks")).ownerPrReferencesMock,
);
vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) =>
    (await import("./chat-tree-host-mocks")).notificationIndicatorsMock(
      importOriginal,
    ),
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).hostReachabilityMock(importOriginal),
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) =>
  (await import("./chat-tree-host-mocks")).cloudChatQueriesMock(importOriginal),
);

const counts = vi.hoisted(() => ({
  panelRenders: 0,
  /** Cloud rows, by owner. */
  rowRenders: new Map<string, number>(),
  /** Local rows' cards, which every local row mounts with it. */
  localCards: 0,
}));

// The panel body builds its row model once per render.
vi.mock(
  "@/components/epic-canvas/sidebar/use-chat-tree-row-model",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/sidebar/use-chat-tree-row-model")
      >();
    return {
      ...actual,
      useChatTreeRowModel: (input: FlattenChatTreeRowsInput) => {
        counts.panelRenders += 1;
        return actual.useChatTreeRowModel(input);
      },
    };
  },
);

// A cloud row names its owner once per render, and each row here has its own.
vi.mock(
  "@/hooks/epics/use-collaborator-display-name",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epics/use-collaborator-display-name")
      >();
    return {
      ...actual,
      useCollaboratorDisplayName: (epicId: string, userId: string | null) => {
        if (userId !== null) {
          counts.rowRenders.set(
            userId,
            (counts.rowRenders.get(userId) ?? 0) + 1,
          );
        }
        return actual.useCollaboratorDisplayName(epicId, userId);
      },
    };
  },
);

// A local row's card places its agent's host once per render.
vi.mock("@/hooks/epic/use-agent-host-projection", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-agent-host-projection")
    >();
  return {
    ...actual,
    useAgentHostProjection: (epicId: string, hostId: string | null) => {
      counts.localCards += 1;
      return actual.useAgentHostProjection(epicId, hostId);
    },
  };
});

const SHARED_READS = ["epic.listCollaborators", "epic.listTaskHosts"] as const;
type SharedRead = (typeof SHARED_READS)[number];
type HostAnswer = "answers" | "refuses";

const LOCAL_COUNT = 30;
const CLOUD_COUNT = 60;
const VIEWPORT_PX = 280;
/** Roughly five rows a step, so every step mounts rows the last one did not. */
const SCROLL_STEP_PX = 150;
/** A row's estimate plus the gap above it. */
const ROW_PITCH_PX = 30;

function cloudChat(index: number): CloudChatSummary {
  const chat = cloudSummary(`cloud-${String(index)}`, null, `Cloud ${index}`);
  return {
    ...chat,
    identity: { ...chat.identity, ownerUserId: `owner-${String(index)}` },
  };
}

function refusal(method: SharedRead, count: number): HostRpcError {
  return new HostRpcError({
    code: "FORBIDDEN",
    message: "refused",
    requestId: `${method}-${String(count)}`,
    method,
    fatalDetails: null,
  });
}

interface Mounted {
  readonly queryClient: QueryClient;
  readonly dispatches: Record<SharedRead, number>;
  /** Renders the same tree again, as a parent's render would. */
  readonly renderAgain: () => void;
}

function createHostClient(
  queryClient: QueryClient,
  answer: HostAnswer,
  dispatches: Record<SharedRead, number>,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "shared-reads",
      handlers: {
        "epic.listTaskHosts": () => {
          dispatches["epic.listTaskHosts"] += 1;
          return answer === "answers"
            ? Promise.resolve({ hosts: [] })
            : Promise.reject(
                refusal("epic.listTaskHosts", dispatches["epic.listTaskHosts"]),
              );
        },
        "epic.listCollaborators": () => {
          dispatches["epic.listCollaborators"] += 1;
          return answer === "answers"
            ? Promise.resolve({
                collaborators: [],
                collaboratorsAvailable: true,
              })
            : Promise.reject(
                refusal(
                  "epic.listCollaborators",
                  dispatches["epic.listCollaborators"],
                ),
              );
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

const opened: OpenedStoreForTest[] = [];

function mountTree(answer: HostAnswer): Mounted {
  // Every mount starts from the same layout, whatever an earlier one scrolled.
  chatTreeLayout.reset();
  chatTreeLayout.setViewport(VIEWPORT_PX);
  const queryClient = createAppQueryClient();
  const dispatches: Record<SharedRead, number> = {
    "epic.listCollaborators": 0,
    "epic.listTaskHosts": 0,
  };
  const client = createHostClient(queryClient, answer, dispatches);
  const session = openChatSession(rootChats(LOCAL_COUNT));
  opened.push(session);
  const tree = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionContext.Provider value={session}>
          <EpicSessionHostClientContext.Provider value={client}>
            <DndContext>
              <ChatTreePanelBody
                epicId={EPIC_ID}
                tabId={TAB_ID}
                messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
              />
            </DndContext>
          </EpicSessionHostClientContext.Provider>
        </EpicSessionContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    queryClient,
    dispatches,
    renderAgain: () => {
      view.rerender(tree());
    },
  };
}

/** Lets React Query deliver what it has scheduled, and React render it. */
async function drained(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      notifyManager.schedule(resolve);
    });
  });
}

/**
 * Both shared reads have an answer or a refusal, nothing is in flight, and
 * every update they caused has rendered.
 */
async function settled(mounted: Mounted): Promise<void> {
  await vi.waitFor(() => {
    for (const method of SHARED_READS) {
      const queries = mounted.queryClient.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey.includes(method) && query.state.status !== "pending",
      });
      expect(queries.length, `${method} has no answer yet`).toBeGreaterThan(0);
    }
    expect(mounted.queryClient.isFetching()).toBe(0);
  });
  await drained();
}

interface Cost {
  readonly dispatches: Record<SharedRead, number>;
  readonly panelRenders: number;
  readonly rowRenders: ReadonlyMap<string, number>;
  readonly localCards: number;
}

function resetCounts(): void {
  counts.panelRenders = 0;
  counts.rowRenders.clear();
  counts.localCards = 0;
}

function costOf(mounted: Mounted): Cost {
  return {
    dispatches: { ...mounted.dispatches },
    panelRenders: counts.panelRenders,
    rowRenders: new Map(counts.rowRenders),
    localCards: counts.localCards,
  };
}

const ONE_EACH: Record<SharedRead, number> = {
  "epic.listCollaborators": 1,
  "epic.listTaskHosts": 1,
};

/**
 * Scrolls the whole list in steps. Returns every request made, mount
 * included, and the renders the scroll cost.
 */
async function scrollAcross(answer: HostAnswer): Promise<Cost> {
  const mounted = mountTree(answer);
  await settled(mounted);
  expect(mounted.dispatches, "the mount asks each read once").toEqual(ONE_EACH);
  resetCounts();
  for (
    let offset = SCROLL_STEP_PX;
    offset <= (LOCAL_COUNT + CLOUD_COUNT) * ROW_PITCH_PX;
    offset += SCROLL_STEP_PX
  ) {
    chatTreeLayout.scrollTo(offset);
    await settled(mounted);
  }
  expect(
    counts.rowRenders.size,
    "the scroll drew most of the cloud rows",
  ).toBeGreaterThan(CLOUD_COUNT / 2);
  const cost = costOf(mounted);
  cleanup();
  return cost;
}

beforeEach(() => {
  setCloudChats(
    Array.from({ length: CLOUD_COUNT }, (_, index) => cloudChat(index)),
  );
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
});

afterEach(() => {
  cleanup();
  for (const handle of opened.splice(0)) handle.dispose();
  setCloudChats([]);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("the task's shared host reads, refused, under the windowed tree", () => {
  it("scrolling across the list asks the host nothing more and costs what it costs when the host answers", async () => {
    const answered = await scrollAcross("answers");
    const refused = await scrollAcross("refuses");

    expect(refused.dispatches).toEqual(ONE_EACH);
    expect(refused.panelRenders).toBe(answered.panelRenders);
    expect(refused.rowRenders).toEqual(answered.rowRenders);
    expect(refused.localCards).toBe(answered.localCards);
  });

  it("a panel render with the task's hosts unchanged renders no mounted row", async () => {
    const mounted = mountTree("answers");
    await settled(mounted);
    expect(counts.rowRenders.size, "cloud rows are drawn").toBeGreaterThan(0);
    resetCounts();

    act(() => {
      mounted.renderAgain();
    });

    expect(counts.panelRenders, "the panel rendered again").toBeGreaterThan(0);
    expect([...counts.rowRenders.keys()]).toEqual([]);
    expect(counts.localCards).toBe(0);
  });

  it("a change to the collaborators alone renders no local row's card", async () => {
    const mounted = mountTree("answers");
    await settled(mounted);
    expect(counts.localCards, "local rows are drawn").toBeGreaterThan(0);
    const answered = mounted.queryClient.getQueryCache().findAll({
      predicate: (query) =>
        query.queryKey.includes("epic.listCollaborators") &&
        query.state.status === "success",
    });
    expect(answered).toHaveLength(1);
    resetCounts();

    act(() => {
      mounted.queryClient.setQueryData(answered[0].queryKey, {
        collaborators: [],
        collaboratorsAvailable: false,
      });
    });
    await drained();

    expect(counts.panelRenders, "the panel read the change").toBeGreaterThan(0);
    expect(counts.localCards).toBe(0);
  });
});
