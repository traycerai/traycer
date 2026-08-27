import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import {
  CHAT_ORIGIN,
  CHAT_OWNERSHIP,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { SORT_DIRECTION, SORT_FIELD } from "@/lib/epic-sort";
import type { ArtifactSearchResults } from "@/components/epic-canvas/sidebar/use-artifact-search-results";

/**
 * The switcher's Agents and Artifacts lists narrow and order through the SAME
 * per-epic store the desktop sidebar writes, so these assertions are the parity
 * claim itself: a view set through the store - which is what the sidebar's own
 * menu does - has to change what the phone renders.
 *
 * The view menus are driven through the store rather than by opening their
 * Radix dropdowns. The menu bodies are the sidebar's own components, covered
 * where they live; what is new here is the wiring between the store and these
 * lists, and a dropdown in jsdom would only stand between the test and it.
 */

interface TestRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: number | null;
  readonly hostId: string;
}

interface TestArtifact {
  readonly id: string;
  readonly kind: string;
  readonly status: number | null;
  readonly updatedAt: number;
}

interface TestHolder {
  records: ReadonlyArray<TestRecord>;
  artifacts: {
    readonly allIds: readonly string[];
    readonly byId: Readonly<Record<string, TestArtifact>>;
  };
  role: string;
  search: ArtifactSearchResults;
}

const INACTIVE_SEARCH: ArtifactSearchResults = {
  searchActive: false,
  results: [],
  response: null,
  isUnsupported: false,
  isError: false,
  isFetching: false,
  refetch: () => {},
};

const holder = vi.hoisted((): TestHolder => ({
  records: [],
  artifacts: { allIds: [], byId: {} },
  role: "owner",
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
  useEpicPermissionRole: () => holder.role,
  useEpicNodeHostId: () => null,
  useEpicActiveAgentIds: () => new Set<string>(),
  useEpicAgentActivityTiers: () => new Map<string, string>(),
  // Read by the archive rule the Show facet brings with it.
  useEpicArchivedNodeIds: (): ReadonlyArray<string> => [],
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  // `type` matters here and not in the sibling list suite: the fuzzy title
  // search reads it to decide which nodes are searchable at all.
  useEpicTreeIndex: () => ({
    rootIds: [],
    childrenByParent: {},
    nodeById: Object.fromEntries(
      holder.records.map((record, index) => [
        record.id,
        {
          id: record.id,
          title: record.name,
          type: record.type,
          createdAt: index,
          updatedAt: index,
        },
      ]),
    ),
  }),
}));
// The artifact filter reads the epic's authoritative artifact map, the same
// source the sidebar filters; outside an epic session the real hook throws.
// The artifact search RPC needs a QueryClient this suite has no reason to
// provide; the request logic is covered where it lives. Keep the real status
// message so any surface wording stays under test.
vi.mock(
  "@/components/epic-canvas/sidebar/use-artifact-search-results",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useArtifactSearchResults: () => holder.search,
  }),
);
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: unknown) => unknown) =>
    selector({ artifacts: holder.artifacts }),
}));
// The archive rule asks which tiles are open, so an archived-but-open row is
// never hidden. Partial mock: everything else in the canvas store stays real.
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOpenTileContentIds: () => new Set<string>(),
}));
vi.mock("@/stores/epics/canvas/canvas-selectors", () => ({
  useIsActiveEpicArtifact: () => false,
  findOpenArtifactInTab: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/use-switcher-activate", () => ({
  useSwitcherActivate: () => vi.fn(),
}));
vi.mock("@/components/epic-canvas/mobile/switcher-row-actions", () => ({
  SwitcherRowActions: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-agent-icon", () => ({
  SwitcherAgentIcon: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewChatAction: () => (
    <button type="button" data-testid="switcher-new-chat" />
  ),
  SwitcherNewArtifactMenu: () => (
    <button type="button" data-testid="new-artifact-action" />
  ),
}));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-A",
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));

const EPIC_ID = "epic-1";
const PROPS = { epicId: EPIC_ID, tabId: "tab-1", onClose: () => {} };

function agentRecord(
  id: string,
  name: string,
  type: "chat" | "terminal-agent",
): TestRecord {
  return { id, name, type, status: null, hostId: "host-A" };
}

function artifactRecord(
  id: string,
  name: string,
  kind: string,
  status: number | null,
): TestRecord {
  return { id, name, type: kind, status, hostId: "host-A" };
}

function seedArtifacts(entries: ReadonlyArray<TestArtifact>): void {
  holder.artifacts = {
    allIds: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  };
}

function renderedAgentNames(): readonly string[] {
  return screen
    .queryAllByTestId(/^switcher-agent-row-/)
    .map((node) => node.textContent);
}

function renderedArtifactNames(): readonly string[] {
  return screen
    .queryAllByTestId(/^switcher-artifact-row-/)
    .map((node) => node.textContent);
}

beforeEach(() => {
  holder.records = [];
  holder.artifacts = { allIds: [], byId: {} };
  holder.role = "owner";
  holder.search = INACTIVE_SEARCH;
  // The store is persisted and app-wide; a view left set by one case would
  // narrow the next one's list for reasons that case never states.
  useLeftPanelStore.setState({
    chatFilterByEpicId: {},
    artifactFilterByEpicId: {},
    chatSortByEpicId: {},
    artifactSortByEpicId: {},
  });
});

afterEach(cleanup);

describe("switcher Agents narrowing", () => {
  it("orders by the epic's chat sort, and re-orders when it changes", () => {
    holder.records = [
      agentRecord("a-1", "Alpha", "chat"),
      agentRecord("a-2", "Bravo", "chat"),
      agentRecord("a-3", "Charlie", "terminal-agent"),
    ];
    const view = render(<SwitcherAgentsList {...PROPS} />);
    // Fixture `updatedAt` ascends with index, and the default mode is
    // most-recently-updated first.
    expect(renderedAgentNames()).toEqual(["Charlie", "Bravo", "Alpha"]);

    useLeftPanelStore.getState().setChatSortField(EPIC_ID, SORT_FIELD.Name);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toEqual(["Charlie", "Bravo", "Alpha"]);

    useLeftPanelStore.getState().toggleChatSortDirection(EPIC_ID);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(useLeftPanelStore.getState().chatSortByEpicId[EPIC_ID]).toEqual({
      field: SORT_FIELD.Name,
      direction: SORT_DIRECTION.Asc,
    });
    expect(renderedAgentNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("distinguishes the two sort directions in the trigger's accessible name", () => {
    // The count badge is aria-hidden and the ordering has no badge at all, so
    // this label is the ONLY channel carrying the direction. Naming the field
    // without it would leave ascending and descending indistinguishable.
    holder.records = [agentRecord("a-1", "Alpha", "chat")];
    useLeftPanelStore.getState().setChatSortField(EPIC_ID, SORT_FIELD.Name);
    const view = render(<SwitcherAgentsList {...PROPS} />);
    expect(
      screen.getByLabelText("Filter agents, ordered by Name descending"),
    ).toBeDefined();

    useLeftPanelStore.getState().toggleChatSortDirection(EPIC_ID);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(
      screen.getByLabelText("Filter agents, ordered by Name ascending"),
    ).toBeDefined();
  });

  it("narrows to one interface when the Interface facet is set", () => {
    holder.records = [
      agentRecord("a-1", "Alpha", "chat"),
      agentRecord("a-2", "Bravo", "terminal-agent"),
    ];
    const view = render(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toHaveLength(2);

    useLeftPanelStore.getState().setChatOrigin(EPIC_ID, CHAT_ORIGIN.Tui);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toEqual(["Bravo"]);

    useLeftPanelStore.getState().setChatOrigin(EPIC_ID, CHAT_ORIGIN.Gui);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toEqual(["Alpha"]);
  });

  it("narrows by title as the user types, and clears back", () => {
    holder.records = [
      agentRecord("a-1", "Refactor the parser", "chat"),
      agentRecord("a-2", "Ship the release", "chat"),
    ];
    render(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toHaveLength(2);

    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
      target: { value: "parser" },
    });
    expect(renderedAgentNames()).toEqual(["Refactor the parser"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear agent search" }));
    expect(renderedAgentNames()).toHaveLength(2);
  });

  it("intersects search with the filter rather than letting either win", () => {
    holder.records = [
      agentRecord("a-1", "Release notes", "chat"),
      agentRecord("a-2", "Release build", "terminal-agent"),
    ];
    useLeftPanelStore.getState().setChatOrigin(EPIC_ID, CHAT_ORIGIN.Tui);
    render(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toEqual(["Release build"]);

    // Matches both titles; only the row surviving the Interface filter stays.
    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
      target: { value: "Release" },
    });
    expect(renderedAgentNames()).toEqual(["Release build"]);

    // Matches only the row the filter excludes, so nothing survives.
    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
      target: { value: "notes" },
    });
    expect(renderedAgentNames()).toEqual([]);
  });

  it("says which control emptied the list, and never that the epic is empty", () => {
    holder.records = [agentRecord("a-1", "Alpha", "chat")];
    const view = render(<SwitcherAgentsList {...PROPS} />);

    useLeftPanelStore.getState().setChatOrigin(EPIC_ID, CHAT_ORIGIN.Tui);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(
      screen.getByText("No matches for the current filters."),
    ).toBeDefined();
    expect(
      screen.getByText("The Interface filter is hiding the other agents."),
    ).toBeDefined();

    // A query that matches nothing is reported as a SEARCH failure even under
    // an active filter - blaming the filter would aim the user at the wrong
    // control - and the filter is named only as a possible second cause.
    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("No agents match your search.")).toBeDefined();
    expect(
      screen.getByText("The current filters may also be hiding matches."),
    ).toBeDefined();
  });

  it("mounts the sidebar's own empty states, with search owning over filter", () => {
    // Same component, ids and precedence as the desktop panel: an epic with
    // nothing gets the "yet" state; a query that matches nothing owns the empty
    // state even under an active filter, because blaming the filter for an
    // unmatched query aims the user at the wrong control.
    const view = render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("epic-chat-sidebar-empty")).toBeDefined();

    holder.records = [agentRecord("a-1", "Alpha", "chat")];
    useLeftPanelStore.getState().setChatOrigin(EPIC_ID, CHAT_ORIGIN.Tui);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("epic-chat-sidebar-filter-empty")).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
      target: { value: "zzzz" },
    });
    expect(screen.getByTestId("epic-chat-sidebar-search-empty")).toBeDefined();
    expect(screen.queryByTestId("epic-chat-sidebar-filter-empty")).toBeNull();
  });

  it("still applies an Ownership filter set from the sidebar, and explains it", () => {
    // The facet has no control on this surface - every local agent is the
    // viewer's own - but the store key is shared, so a desktop-set value must
    // still narrow here rather than being silently ignored.
    holder.records = [agentRecord("a-1", "Alpha", "chat")];
    useLeftPanelStore
      .getState()
      .setChatOwnership(EPIC_ID, CHAT_OWNERSHIP.Others);
    render(<SwitcherAgentsList {...PROPS} />);
    expect(renderedAgentNames()).toEqual([]);
    expect(
      screen.getByText("The Ownership filter is hiding the other agents."),
    ).toBeDefined();
  });
});

describe("switcher Artifacts narrowing", () => {
  it("narrows by status and by kind, and names the cause when empty", () => {
    holder.records = [
      artifactRecord("t-1", "Open ticket", "ticket", 0),
      artifactRecord("t-2", "Done ticket", "ticket", 2),
      artifactRecord("s-1", "A spec", "spec", null),
    ];
    seedArtifacts([
      { id: "t-1", kind: "ticket", status: 0, updatedAt: 1 },
      { id: "t-2", kind: "ticket", status: 2, updatedAt: 2 },
      { id: "s-1", kind: "spec", status: null, updatedAt: 3 },
    ]);
    const view = render(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toHaveLength(3);

    useLeftPanelStore.getState().toggleArtifactStatus(EPIC_ID, 0);
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    // A spec carries no status, so a status constraint excludes it too.
    expect(renderedArtifactNames()).toEqual(["Open ticket"]);

    useLeftPanelStore.getState().toggleArtifactStatus(EPIC_ID, 0);
    useLeftPanelStore.getState().toggleArtifactKind(EPIC_ID, "spec");
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual(["A spec"]);

    useLeftPanelStore.getState().toggleArtifactStatus(EPIC_ID, 2);
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual([]);
    expect(
      screen.getByText("No matches for the current filters."),
    ).toBeDefined();
    expect(
      screen.getByText("Status, Type, or Read state may be hiding artifacts."),
    ).toBeDefined();
  });

  it("keeps the plain empty state when no filter is on", () => {
    render(<SwitcherArtifactsList {...PROPS} />);
    expect(screen.getByText("No artifacts yet.")).toBeDefined();
  });

  it("orders by the epic's artifact sort", () => {
    holder.records = [
      artifactRecord("a-1", "Alpha", "spec", null),
      artifactRecord("a-2", "Bravo", "spec", null),
    ];
    seedArtifacts([
      { id: "a-1", kind: "spec", status: null, updatedAt: 1 },
      { id: "a-2", kind: "spec", status: null, updatedAt: 2 },
    ]);
    const view = render(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual(["Bravo", "Alpha"]);

    useLeftPanelStore.getState().setArtifactSortField(EPIC_ID, SORT_FIELD.Name);
    useLeftPanelStore.getState().toggleArtifactSortDirection(EPIC_ID);
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual(["Alpha", "Bravo"]);
  });
});

describe("switcher Artifacts search", () => {
  const SEEDED = [
    { id: "a-1", kind: "spec", status: null, updatedAt: 1 },
    { id: "a-2", kind: "ticket", status: 0, updatedAt: 2 },
  ];

  function seedTwoArtifacts(): void {
    holder.records = [
      artifactRecord("a-1", "Alpha spec", "spec", null),
      artifactRecord("a-2", "Bravo ticket", "ticket", 0),
    ];
    seedArtifacts(SEEDED);
  }

  // Built from a FIXED base, never from `holder.search`: these cases set one
  // state after another, and inheriting the previous one would leave an earlier
  // flag set - an "error" case still rendering the unsupported branch.
  /**
   * A hit as the host actually returns one. The fields beyond `artifactId` are
   * what the ranking and snippet rendering read; a stub with only the id would
   * typecheck nowhere and would quietly stop representing the producer.
   */
  function hit(artifactId: string, title: string, kind: "spec" | "ticket") {
    return {
      artifactId,
      kind,
      title,
      status: null,
      relativePath: `${artifactId}.md`,
      breadcrumb: [],
      sources: ["title" as const],
      score: 1,
      snippets: [],
    };
  }

  function searchState(
    overrides: Partial<ArtifactSearchResults>,
  ): ArtifactSearchResults {
    return { ...INACTIVE_SEARCH, searchActive: true, ...overrides };
  }

  it("offers the field only on an epic that has artifacts to match", () => {
    render(<SwitcherArtifactsList {...PROPS} />);
    // Emptiness, not size: an epic with nothing to match gets no dead control.
    expect(
      screen.queryByRole("textbox", { name: "Search artifacts" }),
    ).toBeNull();

    cleanup();
    seedTwoArtifacts();
    render(<SwitcherArtifactsList {...PROPS} />);
    expect(
      screen.getByRole("textbox", { name: "Search artifacts" }),
    ).toBeDefined();
  });

  it("renders the host's hits as rows, in the order it ranked them", () => {
    seedTwoArtifacts();
    // Reverse of the list's own sort, so the assertion can only pass if the
    // HOST's ranking is what renders.
    holder.search = searchState({
      results: [
        hit("a-1", "Alpha spec", "spec"),
        hit("a-2", "Bravo ticket", "ticket"),
      ],
      response: { results: [], outcome: "ready", truncated: false },
    });
    render(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual(["Alpha spec", "Bravo ticket"]);
  });

  it("drops a hit the projection cannot resolve, so every row opens", () => {
    seedTwoArtifacts();
    holder.search = searchState({
      results: [hit("a-1", "Alpha spec", "spec"), hit("gone", "Gone", "spec")],
      response: { results: [], outcome: "ready", truncated: false },
    });
    render(<SwitcherArtifactsList {...PROPS} />);
    expect(renderedArtifactNames()).toEqual(["Alpha spec"]);
  });

  it("tells an unsupported host apart from a failure and from no matches", () => {
    seedTwoArtifacts();

    holder.search = searchState({ isUnsupported: true });
    const view = render(<SwitcherArtifactsList {...PROPS} />);
    expect(
      screen.getByText("Search isn't available on this host."),
    ).toBeDefined();

    holder.search = searchState({ isError: true });
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    // Twice on purpose: once in the live region for a screen reader, once
    // visibly. A failure a sighted user can see and a blind one cannot is
    // the reason the status line exists.
    expect(screen.getAllByText("Artifact search failed.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

    holder.search = searchState({
      response: {
        results: [],
        outcome: "mirror-unavailable",
        truncated: false,
      },
    });
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    expect(
      screen.getAllByText("Artifact search isn't ready yet."),
    ).toHaveLength(2);

    holder.search = searchState({
      response: { results: [], outcome: "ready", truncated: false },
    });
    view.rerender(<SwitcherArtifactsList {...PROPS} />);
    expect(screen.getAllByText("No artifacts match your search.")).toHaveLength(
      2,
    );
  });
});
