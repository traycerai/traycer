import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as renderWithoutQueryClient,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CollaboratorEntry } from "@traycer/protocol/host/epic/unary-schemas";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { TaskHostReachContext } from "@/hooks/epic/use-task-host-reach";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  EpicSidebarCloudChatRow,
  type CloudChatRowExpansion,
} from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import type { UnifiedCloudChatEntry } from "@/lib/chats/unified-chat-list";
import {
  ChatTreeSurfaceContext,
  type ChatTreeSurface,
} from "@/components/epic-canvas/sidebar/chat-tree-surface";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { publishedChatTileId } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  recordEndedSandboxHost,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";
import { TaskHostsViewContext } from "@/hooks/sandboxes/use-chat-sandbox-row-line";

/**
 * The row's HOST SCOPE, pinned.
 *
 * This is a regression, not a coverage exercise: the row first shipped reading
 * `useTabHostId()`, and the sidebar is not a tab - it renders outside
 * `<TabHostProvider>`. The guard threw, an error boundary caught it, and the
 * production failure mode was therefore a silently missing row rather than a
 * crash. Nothing about that is visible in a type check, so it needs a mount.
 *
 * The assertion is the MECHANISM: this suite deliberately does NOT wrap the row
 * in a `<TabHostProvider>`, so a tab-scoped host read throws and the render
 * fails. Nothing here clicks anything - jsdom passes clicks on pointer-inert
 * elements, so the open path is verified in the live app instead.
 */

// The serving boundary for a sandbox at rest: only a TEAM sandbox with a
// serving witness is served. The plan carries a pool throughout, so a null
// witness is the negotiated absence (a pool whose handshake lacks
// `chat.serving.subscribe`), the case a no-pool build shares.
vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () => actual.createHostRpcTierPlan(poolEntry),
    };
  },
);

// What tells a collaborator's chat from a team sandbox's: the team environment
// list. Stubbed at its own seam; the ownership hook and the row stay real.
const environments = vi.hoisted(
  (): { list: EnvironmentListResponse | undefined } => ({ list: undefined }),
);
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: environments.list }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

// Typed against the hook's own union so the stand-in cannot produce a status
// the production code has no branch for - an unchecked string here would let a
// typo silently render the unreachable arm under a "reachable" test name.
const reachability: { status: HostReachabilityStatus; hostLabel: string } = {
  status: "unreachable",
  hostLabel: "Tanveer's laptop",
};

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => reachability,
}));

/**
 * The `openTile` seam, captured. The row's whole job on click is to hand a
 * tile intent to it, so what it hands over IS the behaviour under test.
 */
const openedRefs: { type: string; id: string; hostId: string }[] = [];
const openTile = vi.fn((intent: TileOpenIntent) => {
  openedRefs.push({
    type: intent.node.type,
    id: intent.node.id,
    hostId: intent.node.hostId,
  });
});

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));

/**
 * What the tab's active pane is showing, as the two per-row store selectors
 * read it: the active RECORD-BACKED artifact id (a live chat tile), and the
 * active raw tile id (which is all a non-record-backed published copy has).
 * Driven per-test; both hooks answer against this exactly as the real
 * selectors answer against the store.
 */
const activeInTab: { artifactId: string | null; tileId: string | null } = {
  artifactId: null,
  tileId: null,
};

vi.mock("@/stores/epics/canvas/store", () => ({
  useIsActiveEpicArtifact: (_tabId: string | undefined, nodeId: string) =>
    activeInTab.artifactId === nodeId,
  useIsActiveTile: (_tabId: string | undefined, tileId: string | null) =>
    tileId !== null && activeInTab.tileId === tileId,
}));

// The row reads the owner facts and the collaborator list through Query.
let queryClient = new QueryClient();

function render(ui: ReactNode): RenderResult {
  return renderWithoutQueryClient(ui, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  queryClient = new QueryClient();
});

afterEach(() => {
  cleanup();
  useEndedSandboxHostsStore.setState({ byHostId: {} });
  queryClient.clear();
  environments.list = undefined;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  resetHostConnectionRegistryForTest();
  reachability.status = "unreachable";
  openedRefs.length = 0;
  openTile.mockClear();
  activeInTab.artifactId = null;
  activeInTab.tileId = null;
  useSettingsStore.setState({
    artifactIconColorMode: "byType",
    artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
  });
});

/** A leaf row: no subagents beneath it, so no expansion state to consult. */
const NO_CHILDREN: readonly UnifiedCloudChatEntry[] = [];
const LEAF_EXPANSION: CloudChatRowExpansion = {
  expandedIds: new Set<string>(),
  toggleExpanded: () => undefined,
};

const CHAT: CloudChatSummary = {
  identity: {
    taskId: "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7",
    chatId: "56254cae-aa80-4d06-914c-5086cdd65e3c",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-b",
  createdAt: 100,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: 300,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

/** The task's hosts as the Agents panel reads them: host-b, by its label. */
function taskHosts(label: string | null): TaskHostsView {
  return {
    kind: "hosts",
    hosts: [
      {
        hostId: "host-b",
        label,
        principal: { kind: "user", id: "user-1" },
        reach: "same_principal",
        sandboxEnd: null,
      },
    ],
  };
}

/**
 * The `openTile` seam mock runs synchronously, so clicking a row reaches it
 * with the intent the row built.
 */
function clickRow(): void {
  screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`).click();
}

describe("EpicSidebarCloudChatRow", () => {
  it("renders outside a TabHostProvider", () => {
    // The whole regression. A tab-scoped host read would throw here.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });

  it("names the owning host in the ROW's accessible name, not on the glyph", () => {
    // Hosts are a property of the row now, and so is being locked. An
    // `aria-label` on the glyph inside a labelled button never surfaces, and the
    // tooltip beside it is hover-only, so the state has to reach the name the
    // row announces or it reaches nobody. The task's hosts name host-b as a
    // person's machine, as the Agents panel provides them.
    render(
      <TaskHostsViewContext value={taskHosts(null)}>
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />
      </TaskHostsViewContext>,
    );
    expect(
      screen.getByRole("button", {
        name: "Walkthrough — On Tanveer's laptop, offline",
      }),
    ).toBeTruthy();
  });

  const PUBLISHED_CHAT: CloudChatSummary = {
    ...CHAT,
    headSha256: "a".repeat(64),
  };

  it.each([
    [
      "a sandbox the task names, over a chat with no published copy",
      CHAT,
      taskHosts("e2e-sbx-p1"),
      "e2e-sbx-p1 isn't available.",
    ],
    [
      "a sandbox the task names, over a chat with a published copy",
      PUBLISHED_CHAT,
      taskHosts("e2e-sbx-p1"),
      "e2e-sbx-p1 isn't available — this chat stays readable.",
    ],
    [
      "a host nothing names as a sandbox, as an ordinary offline host",
      CHAT,
      { kind: "none" } as const,
      "On Tanveer's laptop, offline",
    ],
  ])("says the lock for %s", (_case, chat, view, line) => {
    render(
      <TaskHostsViewContext value={view}>
        <EpicSidebarCloudChatRow
          chat={chat}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />
      </TaskHostsViewContext>,
    );

    expect(
      screen.getByRole("button", { name: `Walkthrough — ${line}` }),
    ).toBeTruthy();
  });

  it.each([
    [
      "no published head",
      CHAT,
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after resting. Its files are gone.",
      "Opens read-only",
    ],
    [
      "a published head",
      PUBLISHED_CHAT,
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after resting. Its files are gone; this chat stays readable. Opens read-only from the last published copy.",
      null,
    ],
  ])(
    "says a destroyed sandbox's end in the lock's tooltip for a row with %s",
    async (_case, chat, line, absent) => {
      recordEndedSandboxHost("host-b", {
        name: "e2e-sbx-p1",
        at: new Date(2026, 9, 28, 1, 27).getTime(),
        cause: "resting",
        actor: null,
        idleMinutes: null,
      });
      render(
        <TaskHostsViewContext value={{ kind: "none" }}>
          <EpicSidebarCloudChatRow
            chat={chat}
            childEntries={NO_CHILDREN}
            expansion={LEAF_EXPANSION}
            tabId="tab-1"
            depth={0}
            selectionMode={false}
          />
        </TaskHostsViewContext>,
      );

      await userEvent.hover(
        screen.getByTestId(`epic-sidebar-cloud-lock-${chat.identity.chatId}`),
      );

      expect(
        (await screen.findAllByText(line, { exact: true })).length,
      ).toBeGreaterThan(0);
      if (absent !== null) {
        expect(document.body.textContent).not.toContain(absent);
      }
    },
  );

  it("keeps a reachable row's accessible name to the chat title", () => {
    // The row carries a timestamp with its own text; without an explicit label
    // it would announce as both run together - the same reason the local rows
    // set one. A row that is NOT locked has nothing to add to the title.
    reachability.status = "reachable";
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Walkthrough" })).toBeTruthy();
  });

  it("drops the lock when the chat is here and its owner is reachable", () => {
    // The lock is the chat's STATE. It is dropped for a row that will really
    // open live - which needs the chat present on this device as well as its
    // owner answering; a reachable host that does not hold the chat cannot
    // steer it, so claiming otherwise would be the false statement.
    reachability.status = "reachable";
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.queryByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
    ).toBeNull();
  });

  it("locks the row while the owning host is unreachable", () => {
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );
    expect(
      screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });

  describe("what a click actually opens", () => {
    function renderRow(): void {
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
    }

    it("opens LIVE, bound to the owner host, when the owner is reachable", () => {
      // Host ids are unique (2026-08-07 ruling): a reachable owner IS the
      // machine that holds this chat, so the click opens the ordinary live
      // chat ref against it - the same ref shape a tree row opens - and the
      // tile subscribes cross-host without needing a local projection record.
      reachability.status = "reachable";
      renderRow();
      clickRow();
      expect(openedRefs).toHaveLength(1);
      expect(openedRefs[0].type).toBe("chat");
      expect(openedRefs[0].id).toBe(CHAT.identity.chatId);
      expect(openedRefs[0].hostId).toBe(CHAT.ownerHostId);
    });

    it("opens the published copy when the owner is unreachable", () => {
      reachability.status = "unreachable";
      renderRow();
      clickRow();
      expect(openedRefs[0].type).toBe("published-chat");
    });

    it("opens NOTHING while the sidebar is in bulk-selection mode", () => {
      // A cloud row is not selectable - archive and delete are the bulk actions
      // and neither belongs to a chat this device does not own - so it goes
      // inert rather than navigating away from a selection in progress.
      reachability.status = "unreachable";
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode
        />,
      );
      clickRow();
      expect(openedRefs).toHaveLength(0);
    });

    it("never leaves a click opening nothing", () => {
      // The shape of the bug rather than one instance of it: whatever the
      // reachability/presence combination, a click must hand the canvas a ref.
      const statuses: readonly HostReachabilityStatus[] = [
        "reachable",
        "unreachable",
        "checking",
      ];
      for (const status of statuses) {
        {
          reachability.status = status;
          renderRow();
          clickRow();
          expect(openedRefs.length).toBeGreaterThan(0);
          openedRefs.length = 0;
          cleanup();
        }
      }
    });
  });

  describe("the row's icon says STATE, not where the row came from", () => {
    it("draws the same base chat icon as a local row", () => {
      // No row-kind iconography: a distinct glyph for "came from the cloud
      // list" would re-encode the demolished section as an icon.
      reachability.status = "reachable";
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      const row = screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
      expect(row.querySelector(".lucide-message-square")).toBeTruthy();
      expect(
        screen.queryByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
      ).toBeNull();
    });

    it("tints the chat glyph exactly as a local row does", () => {
      // The regression: this row hardcoded `text-muted-foreground` while local
      // rows resolved the settings-driven per-type color, so the icon column
      // encoded row ORIGIN (own = colored, cloud = grey). Read-only-ness is
      // the trailing lock's job; the leading glyph's tint must follow the one
      // shared rule. Default settings = "byType", so the glyph carries the
      // chat color as an inline style and no muted class.
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      const row = screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
      const glyph = row.querySelector(".lucide-message-square");
      if (!(glyph instanceof SVGElement)) {
        throw new Error("cloud row rendered no chat glyph");
      }
      // The tint travels as a custom property, which jsdom stores verbatim,
      // so the assertion states "same color as the settings default" directly
      // rather than through a probe element that agrees on a serialization.
      expect(glyph.style.getPropertyValue("--swatch")).toBe(
        DEFAULT_EPIC_NODE_ICON_COLORS.chat,
      );
      expect(glyph.classList.contains("text-muted-foreground")).toBe(false);
    });

    it("follows a USER-CUSTOMIZED chat color, not a hardcoded default", () => {
      // The default-color case above cannot tell "resolves the settings-driven
      // color" apart from "hardcodes the default" - they render identically
      // until the user actually customizes the color.
      useSettingsStore.setState({
        artifactIconColors: {
          ...DEFAULT_EPIC_NODE_ICON_COLORS,
          chat: "#ff0000",
        },
      });
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      const row = screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
      const glyph = row.querySelector(".lucide-message-square");
      if (!(glyph instanceof SVGElement)) {
        throw new Error("cloud row rendered no chat glyph");
      }
      expect(glyph.style.getPropertyValue("--swatch")).toBe("#ff0000");
      expect(glyph.classList.contains("text-muted-foreground")).toBe(false);
    });

    it("goes muted with the SAME class local rows use when icon colors are off", () => {
      // "None" mode mutes every leading glyph in the column alike - via the
      // shared /70 muted class, not this row's own grey.
      useSettingsStore.setState({ artifactIconColorMode: "none" });
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      const row = screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
      const glyph = row.querySelector(".lucide-message-square");
      if (!(glyph instanceof SVGElement)) {
        throw new Error("cloud row rendered no chat glyph");
      }
      expect(glyph.classList.contains("text-muted-foreground/70")).toBe(true);
      expect(glyph.style.getPropertyValue("--swatch")).toBe("");
    });

    it("badges the lock exactly when the owning host is unreachable", () => {
      reachability.status = "unreachable";
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
      expect(
        screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
      ).toBeTruthy();
    });
  });

  describe("the row highlights when ITS chat is what the tab is showing", () => {
    // The regression: the row hardcoded `aria-selected={false}` and carried
    // only the inactive styling arm, so the active chat's own sidebar row sat
    // unhighlighted while every tree row lit up via the same selectors.
    function renderRow(): void {
      render(
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />,
      );
    }

    function rowButton(): HTMLElement {
      return screen.getByTestId(
        `epic-sidebar-cloud-item-${CHAT.identity.chatId}`,
      );
    }

    it("lights up when the LIVE chat tile for this row's chatId is active", () => {
      // A reachable owner's row opened the ordinary record-backed chat tile,
      // so it announces through the artifact-id selector like a tree row.
      reachability.status = "reachable";
      activeInTab.artifactId = CHAT.identity.chatId;
      renderRow();
      expect(rowButton().classList.contains("bg-accent")).toBe(true);
      expect(rowButton().classList.contains("text-accent-foreground")).toBe(
        true,
      );
      expect(screen.getByRole("treeitem").getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    it("lights up when the PUBLISHED COPY of this row's chat is active", () => {
      // The published tile is deliberately not record-backed, so the artifact
      // selector reads null for it; only its composite tile id can match.
      activeInTab.tileId = publishedChatTileId(CHAT.identity);
      renderRow();
      expect(rowButton().classList.contains("bg-accent")).toBe(true);
      expect(screen.getByRole("treeitem").getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    it("stays on the inactive arm while some OTHER chat is active", () => {
      activeInTab.artifactId = "0d0aa279-1111-4111-8111-111111111111";
      renderRow();
      expect(rowButton().classList.contains("bg-accent")).toBe(false);
      expect(rowButton().classList.contains("text-foreground/75")).toBe(true);
      expect(screen.getByRole("treeitem").getAttribute("aria-selected")).toBe(
        "false",
      );
    });
  });
});

/**
 * A cloud row inside a mounted surface. Its tap must dismiss the surface the
 * same way a local row's does - it sits in the same tree, and a row that opens
 * a tile behind a sheet nothing closes is the bug this covers.
 */
describe("EpicSidebarCloudChatRow on a mounting surface", () => {
  function surfaceValue(onRowActivated: () => void): ChatTreeSurface {
    return {
      onRowActivated,
      revealRowControls: true,
      searchQuery: null,
      startNewChat: () => undefined,
    };
  }

  it("dismisses the surface when the row is tapped", () => {
    let dismissed = 0;
    render(
      <ChatTreeSurfaceContext.Provider
        value={surfaceValue(() => (dismissed += 1))}
      >
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />
      </ChatTreeSurfaceContext.Provider>,
    );

    fireEvent.click(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    );

    expect(dismissed).toBe(1);
  });

  it("does not dismiss on the desktop sidebar, which mounts no surface", () => {
    // Control arm: the same click with no provider must reach the same open
    // path and simply have nothing to dismiss.
    render(
      <EpicSidebarCloudChatRow
        chat={CHAT}
        childEntries={NO_CHILDREN}
        expansion={LEAF_EXPANSION}
        tabId="tab-1"
        depth={0}
        selectionMode={false}
      />,
    );

    fireEvent.click(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    );

    expect(
      screen.getByTestId(`epic-sidebar-cloud-item-${CHAT.identity.chatId}`),
    ).toBeTruthy();
  });
});

/**
 * A chat whose owner is a team sandbox at rest. The owner reads "unreachable"
 * (the stand-in above), so the directory row is what decides: the pool serves
 * a sleeping sandbox's chat, and the live tile it opens shows Resume. The
 * registry is the real one, seeded with the owner's row.
 */
describe("EpicSidebarCloudChatRow for an owner sandbox at rest", () => {
  function seedOwnerRow(
    sandbox: { state: HostSandboxState; frozen: boolean } | null,
    ownerTeamId: string | null,
  ): void {
    const row: RemoteHostDirectoryEntry = {
      hostId: CHAT.ownerHostId,
      label: "Team sandbox",
      kind: "remote",
      websocketUrl: "wss://sandbox.traycer.invalid/rpc",
      version: "0.0.0-mock",
      transportDialability: "dialable",
      publicKey: "public-key",
      relayFuseGrace: false,
      sandbox:
        sandbox === null
          ? null
          : {
              ...sandbox,
              profile: null,
              ownerTeamName: ownerTeamId === null ? null : "acme",
              ownerTeamId,
            },
      remoteStatus: {
        connectivity: "offline",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    };
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => (hostId === row.hostId ? { ...row } : null),
        onDirectoryChanged: () => ({ dispose: () => undefined }),
      },
      leases: null,
    });
  }

  /** A witness that has heard nothing: its presence is all the row reads. */
  const WITNESS: RetainingChatServingWitness = {
    verdictFor: () => "unknown",
    subscribe: () => () => undefined,
    retain: () => () => undefined,
    reopen: () => undefined,
    servingFor: () => null,
  };

  function renderAndClick(witness: RetainingChatServingWitness | null): void {
    render(
      <ChatServingWitnessContext value={witness}>
        <EpicSidebarCloudChatRow
          chat={CHAT}
          childEntries={NO_CHILDREN}
          expansion={LEAF_EXPANSION}
          tabId="tab-1"
          depth={0}
          selectionMode={false}
        />
      </ChatServingWitnessContext>,
    );
    clickRow();
  }

  const lockTestId = `epic-sidebar-cloud-lock-${CHAT.identity.chatId}`;

  it.each(["suspended", "stopped"] as const)(
    "shows no lock and opens LIVE, bound to the sandbox, when it is %s",
    (state) => {
      seedOwnerRow({ state, frozen: false }, "team-1");
      renderAndClick(WITNESS);

      expect(screen.queryByTestId(lockTestId)).toBeNull();
      expect(openedRefs).toEqual([
        {
          type: "chat",
          id: CHAT.identity.chatId,
          hostId: CHAT.ownerHostId,
        },
      ]);
    },
  );

  it.each([
    ["a failed sandbox", { state: "failed", frozen: false }],
    ["a frozen suspended sandbox", { state: "suspended", frozen: true }],
    ["a host that is not a sandbox", null],
  ] as const)("keeps the lock and the published copy for %s", (_name, row) => {
    seedOwnerRow(row, "team-1");
    renderAndClick(WITNESS);

    expect(screen.getByTestId(lockTestId)).toBeTruthy();
    expect(openedRefs.map((ref) => ref.type)).toEqual(["published-chat"]);
  });

  it.each(["suspended", "stopped"] as const)(
    "keeps the lock and the published copy for a %s PERSONAL sandbox",
    (state) => {
      seedOwnerRow({ state, frozen: false }, null);
      renderAndClick(WITNESS);

      expect(screen.getByTestId(lockTestId)).toBeTruthy();
      expect(openedRefs.map((ref) => ref.type)).toEqual(["published-chat"]);
    },
  );

  it.each(["suspended", "stopped"] as const)(
    "keeps the lock and the published copy for a %s team sandbox when the pool serves no witness",
    (state) => {
      seedOwnerRow({ state, frozen: false }, "team-1");
      renderAndClick(null);

      expect(screen.getByTestId(lockTestId)).toBeTruthy();
      expect(openedRefs.map((ref) => ref.type)).toEqual(["published-chat"]);
    },
  );
});

/**
 * A collaborator's chat, locked: the row names the collaborator the task's
 * `epic.listCollaborators` names, through the REAL `useHostQueries` over a
 * recording messenger, and never says "offline" about a machine this account
 * cannot observe.
 */
describe("EpicSidebarCloudChatRow for a collaborator's chat", () => {
  const EPIC_ID = "epic-1";
  const OWNER_USER_ID = CHAT.identity.ownerUserId;
  const collaboratorChat: CloudChatSummary = {
    ...CHAT,
    isOwnedByViewer: false,
  };
  const noopStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => undefined,
  });

  let entries: CollaboratorEntry[] = [];
  let client: HostClient<HostRpcRegistry>;
  let session: OpenedStoreForTest;

  function collaboratorRow(
    profile: { displayName: string; email: string } | null,
  ): CollaboratorEntry {
    return {
      role: "editor",
      accessType: "direct",
      environmentId: null,
      grantedAt: 1,
      grantedBy: "viewer-user",
      user: {
        userId: OWNER_USER_ID,
        profile:
          profile === null ? null : { ...profile, avatarUrl: "", handle: "" },
      },
      team: null,
    };
  }

  beforeEach(() => {
    entries = [];
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "epic.listCollaborators": () => ({
          collaborators: entries,
          collaboratorsAvailable: true,
        }),
      },
    });
    client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === "host-1" ? remoteEntry("host-1", null) : null,
      messenger,
    });
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    recordNegotiatedHostMethods("host-1", ["epic.listCollaborators"]);
    session = openStoreForTest({
      epicId: EPIC_ID,
      userId: "viewer-user",
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-user",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-user", username: "Viewer" },
    });
    // Answered without the owner: a person's chat, not a team sandbox's.
    environments.list = { environments: [] };
  });

  afterEach(() => {
    session.dispose();
    client.dispose();
  });

  /** The task's reach rows name the owner's host as another principal's. */
  const OTHER_PRINCIPAL_HOSTS: ReadonlySet<string> = new Set([
    CHAT.ownerHostId,
  ]);

  function renderCollaboratorRow(
    chat: CloudChatSummary,
    hosts: TaskHostsView,
  ): void {
    render(
      <EpicSessionContext value={session}>
        <EpicSessionHostClientContext
          value={client.createRequesterForHostId("host-1")}
        >
          <TaskHostReachContext value={OTHER_PRINCIPAL_HOSTS}>
            <TaskHostsViewContext value={hosts}>
              <EpicSidebarCloudChatRow
                chat={chat}
                childEntries={NO_CHILDREN}
                expansion={LEAF_EXPANSION}
                tabId="tab-1"
                depth={0}
                selectionMode={false}
              />
            </TaskHostsViewContext>
          </TaskHostReachContext>
        </EpicSessionHostClientContext>
      </EpicSessionContext>,
    );
  }

  it("names the collaborator in the row's accessible name once the list names them", async () => {
    entries = [collaboratorRow({ displayName: "Ada Lovelace", email: "" })];
    renderCollaboratorRow(collaboratorChat, { kind: "none" });

    const row = await screen.findByRole("button", {
      name: "Walkthrough — on Ada Lovelace's computer, not reachable from here",
    });
    expect(row.getAttribute("aria-label")).not.toContain("offline");
    expect(row.getAttribute("aria-label")).not.toContain(
      "not reachable from this host",
    );
  });

  it("says another collaborator while no name has loaded, and for a row that names only the user id", async () => {
    entries = [collaboratorRow(null)];
    renderCollaboratorRow(collaboratorChat, { kind: "none" });

    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(
      screen.getByRole("button", {
        name: "Walkthrough — on another collaborator's computer, not reachable from here",
      }),
    ).toBeTruthy();
  });

  it("puts the same words on the lock's tooltip", async () => {
    entries = [collaboratorRow({ displayName: "Ada Lovelace", email: "" })];
    renderCollaboratorRow(collaboratorChat, { kind: "none" });
    await screen.findByRole("button", {
      name: "Walkthrough — on Ada Lovelace's computer, not reachable from here",
    });

    await userEvent.hover(
      screen.getByTestId(`epic-sidebar-cloud-lock-${CHAT.identity.chatId}`),
    );

    expect(
      (
        await screen.findAllByText(
          "On Ada Lovelace's computer, not reachable from here. Opens read-only from the last published copy.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the reach line after a sandbox owner's own line, even on a collaborator's chat", async () => {
    entries = [collaboratorRow({ displayName: "Ada Lovelace", email: "" })];
    renderCollaboratorRow(collaboratorChat, taskHosts("e2e-sbx-p1"));

    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(
      screen.getByRole("button", {
        name: "Walkthrough — e2e-sbx-p1 isn't available. — not reachable from this host",
      }),
    ).toBeTruthy();
  });

  it("promises the copy for a row whose list entry has no head but whose record table holds one", async () => {
    entries = [collaboratorRow({ displayName: "Ada Lovelace", email: "" })];
    session.store.setState({
      chatRecordHeads: {
        [chatRecordKey(OWNER_USER_ID, collaboratorChat.identity.chatId)]: {
          headSha256: "a".repeat(64),
          publishedAt: 123,
          throughRecordSeq: 1,
        },
      },
    });
    recordEndedSandboxHost("host-b", {
      name: "e2e-sbx-p1",
      at: new Date(2026, 9, 28, 1, 27).getTime(),
      cause: "resting",
      actor: null,
      idleMinutes: null,
    });
    expect(collaboratorChat.headSha256).toBeNull();
    renderCollaboratorRow(collaboratorChat, { kind: "none" });

    await userEvent.hover(
      screen.getByTestId(
        `epic-sidebar-cloud-lock-${collaboratorChat.identity.chatId}`,
      ),
    );

    expect(
      (
        await screen.findAllByText(
          "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 after resting. Its files are gone; this chat stays readable. Opens read-only from the last published copy.",
          { exact: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the offline wording, and the reach line after it, for the viewer's own chat", async () => {
    entries = [collaboratorRow({ displayName: "Ada Lovelace", email: "" })];
    useAuthStore.setState({
      contextMetadata: { userId: OWNER_USER_ID, username: "Owner" },
    });
    renderCollaboratorRow(CHAT, { kind: "none" });

    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(
      screen.getByRole("button", {
        name: "Walkthrough — On Tanveer's laptop, offline — not reachable from this host",
      }),
    ).toBeTruthy();
  });
});
