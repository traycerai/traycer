import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  SearchArtifactHit,
  SearchArtifactsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { UseEpicSearchArtifactsArgs } from "@/hooks/epic/use-epic-search-artifacts-query";

interface QueryResultStub {
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly data: SearchArtifactsResponse | undefined;
  readonly error: { readonly code: string } | null;
  readonly refetch: Mock;
}

interface EpicNodeRefStub {
  readonly id: string;
  readonly type: string;
}

interface ArtifactFilterStub {
  statuses: ReadonlyArray<number>;
  kinds: ReadonlyArray<string>;
  read: "all" | "read" | "unread";
}

interface Harness {
  result: QueryResultStub | null;
  lastArgs: UseEpicSearchArtifactsArgs | null;
  hostId: string | null;
  artifactFilter: ArtifactFilterStub;
  epicNodeRef: EpicNodeRefStub | null;
  openMock: Mock;
  isUnreadMock: Mock<(args: { artifactId: string }) => boolean>;
  artifactsById: Record<string, { updatedAt: number }>;
  /** Drives the >= ARTIFACT_SEARCH_MIN_COUNT gate on the search affordance. */
  artifactIds: ReadonlyArray<string>;
}

const harness = vi.hoisted<Harness>(() => ({
  result: null,
  lastArgs: null,
  hostId: "host-1",
  artifactFilter: { statuses: [], kinds: [], read: "all" },
  epicNodeRef: null,
  openMock: vi.fn(),
  isUnreadMock: vi.fn((_args: { artifactId: string }) => false),
  artifactsById: {},
  artifactIds: [],
}));

vi.mock("@/hooks/epic/use-epic-search-artifacts-query", () => ({
  useEpicSearchArtifacts: (args: UseEpicSearchArtifactsArgs) => {
    harness.lastArgs = args;
    return harness.result;
  },
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => ({}) }));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => harness.hostId,
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({ store: { getState: () => ({}) } }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTilePreviewInTab: harness.openMock,
    openTileInTab: vi.fn(),
    openTileInEpic: vi.fn(),
    openTilePreviewInEpic: vi.fn(),
  }),
}));
vi.mock("@/lib/epic-selectors", () => ({
  epicNodeRefForNodeId: () => harness.epicNodeRef,
}));
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (s: unknown) => unknown) =>
    selector({
      artifacts: {
        byId: harness.artifactsById,
        allIds: harness.artifactIds,
      },
    }),
}));
vi.mock("@/stores/epics/left-panel-store", () => ({
  ARTIFACT_READ: { All: "all", Read: "read", Unread: "unread" },
  useArtifactFilter: () => harness.artifactFilter,
}));
vi.mock("@/stores/epics/artifact-read-state-store", () => {
  // Stable state object so the component's `useShallow` selector returns a
  // stable reference across renders (a fresh object each call would churn the
  // results memo and loop the render-time reset).
  const READ_STATE = { seedAtByEpic: {}, lastSeenByArtifact: {} };
  return {
    isArtifactUnread: (args: { artifactId: string }) =>
      harness.isUnreadMock(args),
    useArtifactReadStateStore: (selector: (s: unknown) => unknown) =>
      selector(READ_STATE),
  };
});

import {
  ArtifactPanelSearchShell,
  ArtifactSearchBox,
} from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-search";
import { ARTIFACT_SEARCH_MIN_COUNT } from "@/components/epic-canvas/sidebar/artifact-search-availability";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";

function loadingResult(): QueryResultStub {
  return {
    isSuccess: false,
    isError: false,
    isFetching: true,
    data: undefined,
    error: null,
    refetch: vi.fn(),
  };
}

function successResult(response: SearchArtifactsResponse): QueryResultStub {
  return {
    isSuccess: true,
    isError: false,
    isFetching: false,
    data: response,
    error: null,
    refetch: vi.fn(),
  };
}

function errorResult(code: string): QueryResultStub {
  return {
    isSuccess: false,
    isError: true,
    isFetching: false,
    data: undefined,
    error: { code },
    refetch: vi.fn(),
  };
}

function hit(overrides: Partial<SearchArtifactHit>): SearchArtifactHit {
  return {
    artifactId: "art-1",
    kind: "ticket",
    title: "Ticket one",
    status: 1,
    relativePath: "tickets/ticket-one/index.md",
    breadcrumb: ["tickets", "ticket-one"],
    sources: ["title"],
    score: 1,
    snippets: [],
    ...overrides,
  };
}

function ready(
  results: ReadonlyArray<SearchArtifactHit>,
  truncated: boolean,
): SearchArtifactsResponse {
  return { outcome: "ready", results: [...results], truncated };
}

/**
 * The box portals its input into the header's slot, so every render needs a
 * registered slot for the input to exist at all. This stands in for
 * `PanelHeaderSearchRow`.
 */
function BoxHarness(props: {
  readonly epicId: string;
  readonly searchQuery: string;
  readonly debouncedQuery: string;
}) {
  const setSearchSlot = usePanelHeaderSearchStore((s) => s.setSearchSlot);
  return (
    <>
      <div
        ref={(element) => setSearchSlot("artifacts", element)}
        data-testid="header-search-slot"
      />
      <ArtifactSearchBox
        epicId={props.epicId}
        tabId="tab-1"
        searchQuery={props.searchQuery}
        debouncedQuery={props.debouncedQuery}
      />
    </>
  );
}

function renderBox(args: {
  readonly searchQuery: string;
  readonly debouncedQuery: string;
  readonly epicId: string;
}) {
  return render(
    <BoxHarness
      epicId={args.epicId}
      searchQuery={args.searchQuery}
      debouncedQuery={args.debouncedQuery}
    />,
  );
}

function searchQueryInStore(): string {
  return usePanelHeaderSearchStore.getState().queryByPanelId.artifacts ?? "";
}

function searchOpenInStore(): boolean {
  return usePanelHeaderSearchStore.getState().openByPanelId.artifacts === true;
}

beforeEach(() => {
  harness.result = loadingResult();
  harness.lastArgs = null;
  harness.hostId = "host-1";
  harness.artifactFilter = { statuses: [], kinds: [], read: "all" };
  harness.epicNodeRef = null;
  harness.openMock = vi.fn();
  harness.isUnreadMock = vi.fn(() => false);
  harness.artifactsById = {};
  harness.artifactIds = [];
  usePanelHeaderSearchStore.setState({
    openByPanelId: {},
    queryByPanelId: {},
    slotByPanelId: {},
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArtifactSearchBox", () => {
  it("renders only the input and no results region when the query is empty", () => {
    renderBox({
      searchQuery: "",
      debouncedQuery: "",
      epicId: "epic-1",
    });
    expect(screen.getByLabelText("Search artifacts")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    // The host query is disabled while the box is empty.
    expect(harness.lastArgs?.enabled).toBe(false);
  });

  it("shows the loading state while the first same-scope result is pending", () => {
    harness.result = loadingResult();
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByTestId("epic-artifact-search-loading")).toBeTruthy();
    expect(harness.lastArgs?.enabled).toBe(true);
    expect(harness.lastArgs?.query).toBe("auth");
  });

  it("renders ranked results without redundant match-source badges and announces the count", () => {
    harness.result = successResult(
      ready(
        [
          hit({ artifactId: "a1", title: "Login flow", sources: ["title"] }),
          hit({
            artifactId: "a2",
            title: "Session store",
            sources: ["title", "body"],
          }),
        ],
        false,
      ),
    );
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    const listbox = screen.getByRole("listbox", {
      name: "Artifact search results",
    });
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("Login flow")).toBeTruthy();
    expect(within(listbox).queryByText("Title")).toBeNull();
    expect(within(listbox).queryByText("Path")).toBeNull();
    expect(within(listbox).queryByText("Body")).toBeNull();
    // Results list keeps the sidebar hidden-scrollbar convention.
    expect(listbox.className).toContain("no-scrollbar");
    expect(screen.getByRole("status").textContent).toContain(
      "2 artifact results",
    );
  });

  it("composes the sidebar kind/status filters into the host request", () => {
    harness.artifactFilter = { statuses: [1], kinds: ["ticket"], read: "all" };
    harness.result = loadingResult();
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(harness.lastArgs?.kinds).toEqual(["ticket"]);
    expect(harness.lastArgs?.statuses).toEqual([1]);
    expect(harness.lastArgs?.subtreePath).toBeNull();
  });

  it("passes null filter axes when no sidebar filter is set", () => {
    harness.result = loadingResult();
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(harness.lastArgs?.kinds).toBeNull();
    expect(harness.lastArgs?.statuses).toBeNull();
  });

  it("moves the active option with arrow keys and opens it on Enter", () => {
    harness.epicNodeRef = { id: "a1", type: "ticket" };
    harness.result = successResult(
      ready(
        [
          hit({ artifactId: "a1", title: "First" }),
          hit({ artifactId: "a2", title: "Second" }),
        ],
        false,
      ),
    );
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    const input = screen.getByLabelText("Search artifacts");
    const options = screen.getAllByRole("option");
    // First option is active by default.
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    // Enter opens the active hit through the authoritative tile-navigation
    // route (the resolved ref is mocked identically for every hit here).
    expect(harness.openMock).toHaveBeenCalledWith("tab-1", {
      id: "a1",
      type: "ticket",
    });
  });

  it("reports a stale hit in place and does not open it", () => {
    harness.epicNodeRef = null; // not in the authoritative projection
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Deleted" })], false),
    );
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-result-a1"));
    expect(harness.openMock).not.toHaveBeenCalled();
    expect(screen.getByText("This artifact no longer exists.")).toBeTruthy();
  });

  it("opens a live hit through the tile-navigation route", () => {
    harness.epicNodeRef = { id: "a1", type: "ticket" };
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Live" })], false),
    );
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-result-a1"));
    expect(harness.openMock).toHaveBeenCalledWith("tab-1", {
      id: "a1",
      type: "ticket",
    });
  });

  it("distinguishes mirror-unavailable from a zero-match result", () => {
    harness.result = successResult({
      outcome: "mirror-unavailable",
      results: [],
      truncated: false,
    });
    const { rerender } = renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(
      screen.getByTestId("epic-artifact-search-mirror-unavailable"),
    ).toBeTruthy();

    harness.result = successResult(ready([], false));
    rerender(
      <BoxHarness epicId="epic-1" searchQuery="auth" debouncedQuery="auth" />,
    );
    expect(screen.getByTestId("epic-artifact-search-empty")).toBeTruthy();
  });

  it("renders the unsupported degrade state without an error", () => {
    harness.result = errorResult("E_HOST_UNSUPPORTED");
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByTestId("epic-artifact-search-unsupported")).toBeTruthy();
    expect(screen.queryByTestId("epic-artifact-search-error")).toBeNull();
  });

  it("renders an error state with a working retry", () => {
    const result = errorResult("RPC_ERROR");
    harness.result = result;
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByTestId("epic-artifact-search-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("epic-artifact-search-retry"));
    expect(result.refetch).toHaveBeenCalledTimes(1);
  });

  it("clears the query on the clear button without leaving search mode", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    usePanelHeaderSearchStore.getState().openSearch("artifacts", "auth");
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-clear"));
    expect(searchQueryInStore()).toBe("");
    // Clearing is not leaving: the header stays swapped so the user can retype.
    expect(searchOpenInStore()).toBe(true);
  });

  it("leaves search mode entirely on Escape, restoring the header row", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    usePanelHeaderSearchStore.getState().openSearch("artifacts", "auth");
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.keyDown(screen.getByLabelText("Search artifacts"), {
      key: "Escape",
    });
    expect(searchOpenInStore()).toBe(false);
    expect(searchQueryInStore()).toBe("");
  });

  it("leaves search mode from the close button", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    usePanelHeaderSearchStore.getState().openSearch("artifacts", "auth");
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-close"));
    expect(searchOpenInStore()).toBe(false);
  });

  it("highlights a multibyte body snippet match", () => {
    harness.result = successResult(
      ready(
        [
          hit({
            artifactId: "a1",
            title: "Unicode",
            sources: ["body"],
            snippets: [
              {
                lineNumber: 1,
                text: "naïve text",
                ranges: [{ startByte: 0, endByte: 6 }],
              },
            ],
          }),
        ],
        false,
      ),
    );
    renderBox({
      searchQuery: "naïve",
      debouncedQuery: "naïve",
      epicId: "epic-1",
    });
    const marks = screen.getAllByText(
      (_content, element) => element?.tagName.toLowerCase() === "mark",
    );
    expect(marks.some((mark) => mark.textContent === "naïve")).toBe(true);
  });

  it("shows a truthful, count-free truncation note and status", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], true));
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    const note = screen.getByText(/More matches exist/);
    // The post-filter count must not leak into the note (would understate the
    // host's truncated page after a renderer-only read filter).
    expect(note.textContent).not.toMatch(/\d/);
    expect(screen.getByRole("status").textContent).toContain(
      "More are available",
    );
  });

  it("gives the input combobox semantics that reference the listbox when shown", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    const input = screen.getByLabelText("Search artifacts");
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(
      `${listbox.id}-option-0`,
    );
  });

  it("does not dangle combobox popup attributes without a listbox", () => {
    // Loading: no listbox in the DOM, so aria-expanded is false and neither
    // aria-controls nor aria-activedescendant may reference a missing element.
    harness.result = loadingResult();
    const { rerender } = renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    let input = screen.getByLabelText("Search artifacts");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    // Empty ready result: still no listbox.
    harness.result = successResult(ready([], false));
    rerender(
      <BoxHarness epicId="epic-1" searchQuery="auth" debouncedQuery="auth" />,
    );
    input = screen.getByLabelText("Search artifacts");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
  });

  it("announces loading exactly once (no duplicate live regions)", () => {
    harness.result = loadingResult();
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].textContent).toContain("Searching artifacts");
    // The spinner itself is decorative, not a second announcement.
    expect(
      screen
        .getByTestId("epic-artifact-search-loading")
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("does not render prior-scope results after the Epic changes (late-echo isolation)", () => {
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Epic A hit" })], false),
    );
    const { rerender } = renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-A",
    });
    expect(screen.getByText("Epic A hit")).toBeTruthy();

    // Epic changes and the new scope's query is still pending: the prior Epic's
    // results must not linger.
    harness.result = loadingResult();
    rerender(
      <BoxHarness epicId="epic-B" searchQuery="auth" debouncedQuery="auth" />,
    );
    expect(screen.queryByText("Epic A hit")).toBeNull();
    expect(screen.getByTestId("epic-artifact-search-loading")).toBeTruthy();
  });

  it("retains same-scope results across keystrokes while the next query loads", () => {
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Kept hit" })], false),
    );
    const { rerender } = renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByText("Kept hit")).toBeTruthy();

    // Only the query string changed (same Epic/host/filters): keep showing the
    // previous same-scope results instead of blanking.
    harness.result = loadingResult();
    rerender(
      <BoxHarness epicId="epic-1" searchQuery="authz" debouncedQuery="authz" />,
    );
    expect(screen.getByText("Kept hit")).toBeTruthy();
  });

  it("applies the renderer-only read filter to results", () => {
    harness.artifactFilter = { statuses: [], kinds: [], read: "unread" };
    harness.artifactsById = { a1: { updatedAt: 10 }, a2: { updatedAt: 20 } };
    // Only a1 is unread.
    harness.isUnreadMock = vi.fn(
      (args: { artifactId: string }): boolean => args.artifactId === "a1",
    );
    harness.result = successResult(
      ready(
        [
          hit({ artifactId: "a1", title: "Unread hit" }),
          hit({ artifactId: "a2", title: "Read hit" }),
        ],
        false,
      ),
    );
    renderBox({
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByText("Unread hit")).toBeTruthy();
    expect(screen.queryByText("Read hit")).toBeNull();
  });
});

describe("ArtifactPanelSearchShell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "A hit" })], false),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The shell renders only the tree; the input is portaled into the header
   * slot, which the section header owns. This stands in for that header.
   */
  function ShellHarness() {
    const setSearchSlot = usePanelHeaderSearchStore((s) => s.setSearchSlot);
    return (
      <>
        <div
          ref={(element) => setSearchSlot("artifacts", element)}
          data-testid="header-search-slot"
        />
        <ArtifactPanelSearchShell epicId="epic-1" tabId="tab-1">
          <div data-testid="tree-stub">artifact tree</div>
        </ArtifactPanelSearchShell>
      </>
    );
  }

  /** Enough artifacts that the search affordance is available. */
  function withSearchableArtifactCount() {
    harness.artifactIds = Array.from(
      { length: ARTIFACT_SEARCH_MIN_COUNT },
      (_unused, index) => `art-${index}`,
    );
  }

  function renderShell(args: { readonly searchOpen: boolean }) {
    withSearchableArtifactCount();
    if (args.searchOpen) {
      usePanelHeaderSearchStore.getState().openSearch("artifacts", "");
    }
    return render(<ShellHarness />);
  }

  function typeAndSettle(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
  }

  it("renders no search input at all in browse mode", () => {
    renderShell({ searchOpen: false });
    // The whole point of the rework: browse mode spends zero rows on search.
    expect(screen.queryByLabelText("Search artifacts")).toBeNull();
    expect(screen.getByTestId("tree-stub")).toBeTruthy();
  });

  it("enters search mode seeded with the typed character", () => {
    renderShell({ searchOpen: false });
    fireEvent.keyDown(screen.getByTestId("epic-artifact-tree-region"), {
      key: "a",
    });
    // The keystroke that started the search is not swallowed by the handoff.
    expect(searchOpenInStore()).toBe(true);
    expect(searchQueryInStore()).toBe("a");
    expect(screen.getByLabelText("Search artifacts")).toBeTruthy();
  });

  it("ignores type-to-filter below the artifact-count threshold", () => {
    harness.artifactIds = Array.from(
      { length: ARTIFACT_SEARCH_MIN_COUNT - 1 },
      (_unused, index) => `art-${index}`,
    );
    render(<ShellHarness />);
    fireEvent.keyDown(screen.getByTestId("epic-artifact-tree-region"), {
      key: "a",
    });
    expect(searchOpenInStore()).toBe(false);
  });

  it("ignores modified keys so shortcuts still reach their handlers", () => {
    renderShell({ searchOpen: false });
    const region = screen.getByTestId("epic-artifact-tree-region");
    fireEvent.keyDown(region, { key: "a", metaKey: true });
    fireEvent.keyDown(region, { key: " " });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(searchOpenInStore()).toBe(false);
  });

  it("does not steal typed input from an editable tree descendant", () => {
    renderShell({ searchOpen: false });
    const region = screen.getByTestId("epic-artifact-tree-region");
    const input = document.createElement("input");
    region.append(input);
    fireEvent.keyDown(input, { key: "a" });
    expect(searchOpenInStore()).toBe(false);
  });

  it("keeps the tree viewport as the hidden-scrollbar single scroll surface", () => {
    renderShell({ searchOpen: false });
    const region = screen.getByTestId("epic-artifact-tree-region");
    // The inner tree viewport is the active scroll surface and keeps the
    // sidebar's hidden-scrollbar convention that SidebarContent used to provide.
    expect(region.className).toContain("overflow-auto");
    expect(region.className).toContain("no-scrollbar");
  });

  it("keeps the tree mounted but hidden while a query is active", () => {
    renderShell({ searchOpen: true });
    const input = screen.getByLabelText("Search artifacts");
    const region = screen.getByTestId("epic-artifact-tree-region");
    expect(region.className).not.toContain("hidden");

    typeAndSettle(input, "auth");
    // Tree is still in the DOM (mounted), just hidden — expansion/scroll survive.
    expect(screen.getByTestId("tree-stub")).toBeTruthy();
    expect(screen.getByTestId("epic-artifact-tree-region").className).toContain(
      "hidden",
    );
  });

  it("restores the tree in the same cycle on clear (no debounce lag)", () => {
    renderShell({ searchOpen: true });
    const input = screen.getByLabelText("Search artifacts");
    typeAndSettle(input, "auth");
    expect(screen.getByTestId("epic-artifact-tree-region").className).toContain(
      "hidden",
    );

    // Clear: the tree must return immediately, without advancing the debounce.
    fireEvent.click(screen.getByTestId("epic-artifact-search-clear"));
    expect(
      screen.getByTestId("epic-artifact-tree-region").className,
    ).not.toContain("hidden");
  });

  it("restores the tree in the same cycle on Escape", () => {
    renderShell({ searchOpen: true });
    const input = screen.getByLabelText("Search artifacts");
    typeAndSettle(input, "auth");
    expect(screen.getByTestId("epic-artifact-tree-region").className).toContain(
      "hidden",
    );

    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.getByTestId("epic-artifact-tree-region").className,
    ).not.toContain("hidden");
  });

  it("restores the tree scroll position when leaving search mode", () => {
    renderShell({ searchOpen: true });
    const input = screen.getByLabelText("Search artifacts");
    const region = screen.getByTestId("epic-artifact-tree-region");

    // The user scrolls the tree, then searches.
    region.scrollTop = 120;
    fireEvent.scroll(region);
    typeAndSettle(input, "auth");

    // Simulate the viewport being lost while the tree is hidden.
    region.scrollTop = 0;
    fireEvent.click(screen.getByTestId("epic-artifact-search-clear"));

    expect(screen.getByTestId("epic-artifact-tree-region").scrollTop).toBe(120);
  });
});
