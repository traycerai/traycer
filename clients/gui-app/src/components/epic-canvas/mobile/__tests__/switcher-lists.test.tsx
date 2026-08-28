import {
  cleanup,
  render as rtlRender,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ReactElement, ReactNode } from "react";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { STATUS_DOT_CLASSES } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import type { ArtifactSearchResults } from "@/components/epic-canvas/sidebar/use-artifact-search-results";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

interface FixtureRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: string;
  readonly status: number | null;
  readonly hostId: string;
}
/**
 * The whole ref, not just its `type`. The ref's `hostId` is what the opened
 * tile BINDS TO for life, so it is the field most worth asserting - and a
 * fixture that dropped it is why a wrong-host ref went unnoticed here.
 */
interface ActivateRef {
  readonly id: string;
  readonly type: string;
  readonly hostId: string;
}
interface ActivateCall {
  readonly id: string;
  readonly ref: ActivateRef;
}
interface Holder {
  records: ReadonlyArray<FixtureRecord>;
  activeId: string | null;
  role: "owner" | "viewer";
  activateCalls: ActivateCall[];
  workingAgentIds: ReadonlySet<string>;
  activityTiers: ReadonlyMap<string, "turn" | "background">;
  /** Chat ids the agents list subscribed indicator state for, per render. */
  indicatorChatIdCalls: ReadonlyArray<string>[];
  /** What `useEpicNodeHostId` answers - the row's OWN owner host. */
  ownerHostIdByNodeId: Record<string, string>;
  indicators: IndicatorFixture;
  search: ArtifactSearchResults;
}

interface IndicatorFlags {
  readonly unreadFailure: boolean;
  readonly pendingFork: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}
interface IndicatorResponseFixture {
  readonly epics: Record<string, never>;
  readonly chats: Record<string, IndicatorFlags>;
}
interface IndicatorFixture extends IndicatorResponseFixture {
  readonly byOriginHostId?: Record<string, IndicatorResponseFixture>;
}

const holder = vi.hoisted((): Holder => ({
  records: [],
  activeId: null,
  role: "owner",
  activateCalls: [],
  workingAgentIds: new Set<string>(),
  activityTiers: new Map<string, "turn" | "background">(),
  indicatorChatIdCalls: [],
  ownerHostIdByNodeId: {},
  indicators: { epics: {}, chats: {} },
  search: {
    searchActive: false,
    results: [],
    response: null,
    isUnsupported: false,
    isError: false,
    isFetching: false,
    refetch: () => {},
  },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => holder.records,
  useEpicActiveAgentIds: () => holder.workingAgentIds,
  useEpicAgentActivityTiers: () => holder.activityTiers,
  // Read by the archive rule the Show facet brings with it.
  useEpicArchivedNodeIds: (): ReadonlyArray<string> => [],
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useEpicPermissionRole: () => holder.role,
  // The chat projection's OWN host. Deliberately distinct from the `hostId` on
  // the records above, which is the app-wide ACTIVE host for chat rows.
  useEpicNodeHostId: (nodeId: string) =>
    holder.ownerHostIdByNodeId[nodeId] ?? null,
  // The lists sort by tree-node recency; expose nodes for the fixtures so the
  // real epic-sort comparator resolves every id.
  useEpicTreeIndex: () => ({
    rootIds: [],
    childrenByParent: {},
    nodeById: Object.fromEntries(
      holder.records.map((record, index) => [
        record.id,
        {
          id: record.id,
          title: record.name,
          createdAt: index,
          updatedAt: index,
        },
      ]),
    ),
  }),
}));
// The archive rule asks which tiles are open, so an archived-but-open row is
// never hidden. Partial mock: everything else in the canvas store stays real.
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOpenTileContentIds: () => new Set<string>(),
}));
vi.mock("@/stores/epics/canvas/canvas-selectors", () => ({
  useIsActiveEpicArtifact: (_tabId: string, id: string) =>
    holder.activeId === id,
  findOpenArtifactInTab: () => null,
}));
// The artifact search RPC needs a QueryClient this suite has no reason to
// provide; the request logic is covered where it lives. Keep the real status
// message so any surface wording stays under test.
//
// `useEpicStore` is deliberately NOT mocked: this suite now renders inside a
// real `EpicSessionContext`, so the artifact map the list filters against is
// the genuine projection. Stubbing it here would answer a question the harness
// already answers, and answer it differently.
vi.mock(
  "@/components/epic-canvas/sidebar/use-artifact-search-results",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useArtifactSearchResults: () => holder.search,
  }),
);
vi.mock("@/components/epic-canvas/mobile/use-switcher-activate", () => ({
  // The row hands over the REF alone; the content id it names is the ref's own
  // `id`, which is also what the canvas dedups against.
  useSwitcherActivate: () => (buildRef: () => ActivateRef) => {
    const ref = buildRef();
    holder.activateCalls.push({ id: ref.id, ref });
  },
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-A",
}));
// Keep the row menu's mutation + focus hooks inert so it mounts without a
// QueryClient / host client (the menu's editor gating is what we assert).
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteChat: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicDeleteArtifact: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
// The agents list owns the indicator subscription its rows read through
// context; record what it asks for so the wiring is asserted rather than
// assumed, and answer from the holder.
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-A",
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: (args: {
    readonly chatIds: readonly string[];
  }) => {
    holder.indicatorChatIdCalls.push(args.chatIds);
    return holder.indicators;
  },
}));
// Each category list renders its own create row/menu (Agents: New chat,
// Terminals: New terminal, Artifacts: a "+" kind menu); stub all three to
// markers so their own wiring (composer mode, the terminal picker dialog, the
// artifact-kind dropdown) doesn't need to mount here - this file exercises
// each list's editor gating and row positioning in isolation.
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewChatAction: () => (
    <button type="button" data-testid="switcher-new-chat" />
  ),
  SwitcherNewTerminalRow: () => (
    <button type="button" data-testid="switcher-new-terminal" />
  ),
  SwitcherNewArtifactMenu: () => (
    <button type="button" data-testid="new-artifact-action" />
  ),
}));

const PROPS = { epicId: "epic-1", tabId: "tab-1", onClose: () => {} };

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/**
 * `SwitcherRowActions` (each row's "…" menu) calls `useSwitcherRename`, which
 * now reads a real session handle for the optimistic overlay
 * (`beginRenameMutation` / `retirePendingMutation`) rather than firing bare
 * RPCs - so every render in this suite needs `<EpicSessionContext.Provider>`
 * around it, not just the tests that exercise a rename. No test here commits
 * an edit through the menu, so an empty doc is enough for the session to
 * mount without throwing.
 */
function newSessionHandle(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

let sessionHandle: OpenEpicStoreHandle;

function SessionWrapper(props: { readonly children: ReactNode }): ReactElement {
  return (
    <EpicSessionContext.Provider value={sessionHandle}>
      {props.children}
    </EpicSessionContext.Provider>
  );
}

/**
 * The one shared fix: every render in this file goes through the provider.
 * Uses RTL's `wrapper` option (not a hand-nested element) specifically so it
 * survives `view.rerender(...)` below - a bare nested element would have the
 * wrapper swapped OUT the moment a test re-renders with an unwrapped element,
 * since `rerender` diffs against whatever the root element WAS.
 */
function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: SessionWrapper });
}

beforeEach(() => {
  holder.records = [];
  holder.activeId = null;
  holder.role = "owner";
  holder.activateCalls = [];
  holder.workingAgentIds = new Set<string>();
  holder.activityTiers = new Map<string, "turn" | "background">();
  holder.indicatorChatIdCalls = [];
  holder.ownerHostIdByNodeId = {};
  holder.indicators = { epics: {}, chats: {} };
  sessionHandle = newSessionHandle();
});
afterEach(() => {
  cleanup();
  sessionHandle.dispose();
});

describe("<SwitcherArtifactsList />", () => {
  it("renders artifact rows with a status dot for a ticket", () => {
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-A",
      },
      {
        id: "tk-1",
        parentId: null,
        name: "Ticket One",
        type: "ticket",
        status: 1,
        hostId: "host-A",
      },
    ];
    render(<SwitcherArtifactsList {...PROPS} />);
    // Chats are excluded from the artifacts list.
    expect(screen.queryByTestId("switcher-artifact-row-chat-1")).toBeNull();
    const row = screen.getByTestId("switcher-artifact-row-tk-1");
    expect(row.textContent).toContain("Ticket One");
    // The status dot is a decorative (`aria-hidden`) touch-surface affordance
    // with no title/aria-label - status color is the only signal, mirroring
    // the desktop `STATUS_DOT_CLASSES` palette.
    const statusDot = row.querySelector(".rounded-full");
    expect(statusDot).not.toBeNull();
    expect(statusDot?.className).toContain(STATUS_DOT_CLASSES[1]);
  });
});
