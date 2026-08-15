import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useCallback, useRef, type ReactNode } from "react";
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
  /**
   * The Epic's artifact ids. No longer gates the search affordance - the count
   * gate is gone - but the projection mock still has to answer `allIds`.
   */
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
import {
  panelHeaderSearchSurfaceKey,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";

const ARTIFACTS_PANEL_ID = "artifacts" as const;
const DEFAULT_TAB_ID = "tab-1";
const DEFAULT_EPIC_ID = "epic-1";

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
 * Mirrors `PanelHeaderSearchRow`'s register/unregister slot contract so tests
 * exercise the same identity-guarded cleanup path production uses.
 */
function HeaderSearchSlot(props: {
  readonly tabId: string;
  readonly testId: string;
}) {
  const registerSearchSlot = usePanelHeaderSearchStore(
    (state) => state.registerSearchSlot,
  );
  const unregisterSearchSlot = usePanelHeaderSearchStore(
    (state) => state.unregisterSearchSlot,
  );
  const currentSlotRef = useRef<HTMLDivElement | null>(null);
  const setSlotRef = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = currentSlotRef.current;
      if (previous !== null && previous !== element) {
        unregisterSearchSlot(props.tabId, ARTIFACTS_PANEL_ID, previous);
      }
      currentSlotRef.current = element;
      if (element !== null) {
        registerSearchSlot(props.tabId, ARTIFACTS_PANEL_ID, element);
      }
    },
    [props.tabId, registerSearchSlot, unregisterSearchSlot],
  );
  return <div ref={setSlotRef} data-testid={props.testId} />;
}

/**
 * The box portals its input into the header's slot, so every render needs a
 * registered slot for the input to exist at all. This stands in for
 * `PanelHeaderSearchRow`.
 */
function BoxHarness(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly searchQuery: string;
  readonly debouncedQuery: string;
}) {
  return (
    <>
      <HeaderSearchSlot
        tabId={props.tabId}
        testId={`header-search-slot-${props.tabId}`}
      />
      <ArtifactSearchBox
        epicId={props.epicId}
        tabId={props.tabId}
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
  readonly tabId: string;
}) {
  return render(
    <BoxHarness
      epicId={args.epicId}
      tabId={args.tabId}
      searchQuery={args.searchQuery}
      debouncedQuery={args.debouncedQuery}
    />,
  );
}

function surfaceKey(tabId: string): string {
  return panelHeaderSearchSurfaceKey(tabId, ARTIFACTS_PANEL_ID);
}

function searchQueryInStore(tabId: string): string {
  return (
    usePanelHeaderSearchStore.getState().queryBySurfaceKey[surfaceKey(tabId)] ??
    ""
  );
}

function searchOpenInStore(tabId: string): boolean {
  return (
    usePanelHeaderSearchStore.getState().openBySurfaceKey[surfaceKey(tabId)] ===
    true
  );
}

function searchSlotInStore(tabId: string): HTMLElement | undefined {
  return usePanelHeaderSearchStore.getState().slotBySurfaceKey[
    surfaceKey(tabId)
  ];
}

function openArtifactsSearch(tabId: string, seed: string): void {
  usePanelHeaderSearchStore
    .getState()
    .openSearch(tabId, ARTIFACTS_PANEL_ID, seed);
}

function resetHeaderSearchStore(): void {
  usePanelHeaderSearchStore.setState({
    openBySurfaceKey: {},
    queryBySurfaceKey: {},
    slotBySurfaceKey: {},
  });
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
  resetHeaderSearchStore();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArtifactSearchBox", () => {
  it("renders only the input and no results region when the query is empty", () => {
    renderBox({
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(
      screen.getByTestId("epic-artifact-search-mirror-unavailable"),
    ).toBeTruthy();

    harness.result = successResult(ready([], false));
    rerender(
      <BoxHarness
        epicId="epic-1"
        tabId={DEFAULT_TAB_ID}
        searchQuery="auth"
        debouncedQuery="auth"
      />,
    );
    expect(screen.getByTestId("epic-artifact-search-empty")).toBeTruthy();
  });

  it("renders the unsupported degrade state without an error", () => {
    harness.result = errorResult("E_HOST_UNSUPPORTED");
    renderBox({
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
    openArtifactsSearch(DEFAULT_TAB_ID, "auth");
    renderBox({
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-clear"));
    expect(searchQueryInStore(DEFAULT_TAB_ID)).toBe("");
    // Clearing is not leaving: the header stays swapped so the user can retype.
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(true);
  });

  it("leaves search mode entirely on Escape, restoring the header row", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    openArtifactsSearch(DEFAULT_TAB_ID, "auth");
    renderBox({
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.keyDown(screen.getByLabelText("Search artifacts"), {
      key: "Escape",
    });
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(false);
    expect(searchQueryInStore(DEFAULT_TAB_ID)).toBe("");
  });

  it("leaves search mode from the close button", () => {
    harness.result = successResult(ready([hit({ artifactId: "a1" })], false));
    openArtifactsSearch(DEFAULT_TAB_ID, "auth");
    renderBox({
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    fireEvent.click(screen.getByTestId("epic-artifact-search-close"));
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(false);
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
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
      <BoxHarness
        epicId="epic-1"
        tabId={DEFAULT_TAB_ID}
        searchQuery="auth"
        debouncedQuery="auth"
      />,
    );
    input = screen.getByLabelText("Search artifacts");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
  });

  it("announces loading exactly once (no duplicate live regions)", () => {
    harness.result = loadingResult();
    renderBox({
      tabId: DEFAULT_TAB_ID,
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
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-A",
    });
    expect(screen.getByText("Epic A hit")).toBeTruthy();

    // Epic changes and the new scope's query is still pending: the prior Epic's
    // results must not linger.
    harness.result = loadingResult();
    rerender(
      <BoxHarness
        epicId="epic-B"
        tabId={DEFAULT_TAB_ID}
        searchQuery="auth"
        debouncedQuery="auth"
      />,
    );
    expect(screen.queryByText("Epic A hit")).toBeNull();
    expect(screen.getByTestId("epic-artifact-search-loading")).toBeTruthy();
  });

  it("retains same-scope results across keystrokes while the next query loads", () => {
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Kept hit" })], false),
    );
    const { rerender } = renderBox({
      tabId: DEFAULT_TAB_ID,
      searchQuery: "auth",
      debouncedQuery: "auth",
      epicId: "epic-1",
    });
    expect(screen.getByText("Kept hit")).toBeTruthy();

    // Only the query string changed (same Epic/host/filters): keep showing the
    // previous same-scope results instead of blanking.
    harness.result = loadingResult();
    rerender(
      <BoxHarness
        epicId="epic-1"
        tabId={DEFAULT_TAB_ID}
        searchQuery="authz"
        debouncedQuery="authz"
      />,
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
      tabId: DEFAULT_TAB_ID,
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
  function ShellHarness(props: {
    readonly epicId: string;
    readonly tabId: string;
    readonly children: ReactNode;
  }) {
    return (
      <>
        <HeaderSearchSlot
          tabId={props.tabId}
          testId={`header-search-slot-${props.tabId}`}
        />
        <ArtifactPanelSearchShell epicId={props.epicId} tabId={props.tabId}>
          {props.children}
        </ArtifactPanelSearchShell>
      </>
    );
  }

  function defaultTreeStub(testId: string): ReactNode {
    return <div data-testid={testId}>artifact tree</div>;
  }

  function renderShell(args: {
    readonly searchOpen: boolean;
    readonly tabId: string;
    readonly epicId: string;
  }) {
    if (args.searchOpen) {
      openArtifactsSearch(args.tabId, "");
    }
    return render(
      <ShellHarness epicId={args.epicId} tabId={args.tabId}>
        {defaultTreeStub("tree-stub")}
      </ShellHarness>,
    );
  }

  function typeAndSettle(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
  }

  it("renders no search input at all in browse mode", () => {
    renderShell({
      searchOpen: false,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
    // The whole point of the rework: browse mode spends zero rows on search.
    expect(screen.queryByLabelText("Search artifacts")).toBeNull();
    expect(screen.getByTestId("tree-stub")).toBeTruthy();
  });

  it("enters search mode seeded with the typed character", () => {
    renderShell({
      searchOpen: false,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
    fireEvent.keyDown(screen.getByTestId("epic-artifact-tree-region"), {
      key: "a",
    });
    // The keystroke that started the search is not swallowed by the handoff.
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(true);
    expect(searchQueryInStore(DEFAULT_TAB_ID)).toBe("a");
    expect(screen.getByLabelText("Search artifacts")).toBeTruthy();
  });

  // Regression: search used to be gated on the Epic holding >= 10 artifacts,
  // which silently removed both this path and the header menu item from every
  // smaller Epic. There is no threshold any more - a one-artifact Epic searches.
  it("enters search mode however few artifacts the Epic holds", () => {
    harness.artifactIds = ["art-0"];
    render(
      <ShellHarness epicId={DEFAULT_EPIC_ID} tabId={DEFAULT_TAB_ID}>
        {defaultTreeStub("tree-stub")}
      </ShellHarness>,
    );
    fireEvent.keyDown(screen.getByTestId("epic-artifact-tree-region"), {
      key: "a",
    });
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(true);
    expect(searchQueryInStore(DEFAULT_TAB_ID)).toBe("a");
  });

  it("ignores modified keys so shortcuts still reach their handlers", () => {
    renderShell({
      searchOpen: false,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
    const region = screen.getByTestId("epic-artifact-tree-region");
    fireEvent.keyDown(region, { key: "a", metaKey: true });
    fireEvent.keyDown(region, { key: " " });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(false);
  });

  it("does not steal typed input from an editable tree descendant", () => {
    renderShell({
      searchOpen: false,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
    const region = screen.getByTestId("epic-artifact-tree-region");
    const input = document.createElement("input");
    region.append(input);
    fireEvent.keyDown(input, { key: "a" });
    expect(searchOpenInStore(DEFAULT_TAB_ID)).toBe(false);
  });

  it("keeps the tree viewport as the hidden-scrollbar single scroll surface", () => {
    renderShell({
      searchOpen: false,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
    const region = screen.getByTestId("epic-artifact-tree-region");
    // The inner tree viewport is the active scroll surface and keeps the
    // sidebar's hidden-scrollbar convention that SidebarContent used to provide.
    expect(region.className).toContain("overflow-auto");
    expect(region.className).toContain("no-scrollbar");
  });

  it("keeps the tree mounted but hidden while a query is active", () => {
    renderShell({
      searchOpen: true,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
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
    renderShell({
      searchOpen: true,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
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
    renderShell({
      searchOpen: true,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
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
    renderShell({
      searchOpen: true,
      tabId: DEFAULT_TAB_ID,
      epicId: DEFAULT_EPIC_ID,
    });
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

describe("panel-header-search store slot identity guards", () => {
  it("unregisterSearchSlot ignores a stale ref after the same surface was re-registered", () => {
    const store = usePanelHeaderSearchStore.getState();
    const oldA = document.createElement("div");
    const replacementA = document.createElement("div");
    const slotB = document.createElement("div");

    // Exact production-style stale-ref sequence: register, overwrite, then the
    // old element's cleanup must not clobber the replacement (or touch B).
    store.registerSearchSlot("tab-a", ARTIFACTS_PANEL_ID, oldA);
    store.registerSearchSlot("tab-b", ARTIFACTS_PANEL_ID, slotB);
    store.registerSearchSlot("tab-a", ARTIFACTS_PANEL_ID, replacementA);
    expect(searchSlotInStore("tab-a")).toBe(replacementA);
    expect(searchSlotInStore("tab-b")).toBe(slotB);

    store.unregisterSearchSlot("tab-a", ARTIFACTS_PANEL_ID, oldA);
    expect(searchSlotInStore("tab-a")).toBe(replacementA);
    expect(searchSlotInStore("tab-b")).toBe(slotB);

    store.unregisterSearchSlot("tab-a", ARTIFACTS_PANEL_ID, replacementA);
    expect(searchSlotInStore("tab-a")).toBeUndefined();
    expect(searchSlotInStore("tab-b")).toBe(slotB);
  });

  it("open/close/query mutations on one surface leave the other surface untouched", () => {
    const store = usePanelHeaderSearchStore.getState();
    store.openSearch("tab-a", ARTIFACTS_PANEL_ID, "a");
    store.openSearch("tab-b", ARTIFACTS_PANEL_ID, "b");
    expect(searchOpenInStore("tab-a")).toBe(true);
    expect(searchOpenInStore("tab-b")).toBe(true);
    expect(searchQueryInStore("tab-a")).toBe("a");
    expect(searchQueryInStore("tab-b")).toBe("b");

    store.setSearchQuery("tab-a", ARTIFACTS_PANEL_ID, "auth");
    expect(searchQueryInStore("tab-a")).toBe("auth");
    expect(searchQueryInStore("tab-b")).toBe("b");

    store.closeSearch("tab-a", ARTIFACTS_PANEL_ID);
    expect(searchOpenInStore("tab-a")).toBe(false);
    expect(searchQueryInStore("tab-a")).toBe("");
    expect(searchOpenInStore("tab-b")).toBe(true);
    expect(searchQueryInStore("tab-b")).toBe("b");
  });
});

describe("ArtifactPanelSearchShell dual-surface isolation", () => {
  const TAB_A = "tab-a";
  const TAB_B = "tab-b";
  const EPIC_A = "epic-a";
  const EPIC_B = "epic-b";

  beforeEach(() => {
    vi.useFakeTimers();
    harness.result = successResult(
      ready([hit({ artifactId: "a1", title: "Shared hit" })], false),
    );
    harness.epicNodeRef = { id: "a1", type: "ticket" };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function DualSurfaceHarness(props: {
    readonly mountA: boolean;
    readonly mountB: boolean;
  }) {
    return (
      <>
        {props.mountA ? (
          <div data-testid="surface-a">
            <HeaderSearchSlot
              tabId={TAB_A}
              testId={`header-search-slot-${TAB_A}`}
            />
            <ArtifactPanelSearchShell epicId={EPIC_A} tabId={TAB_A}>
              <div data-testid="tree-a">tree a</div>
            </ArtifactPanelSearchShell>
          </div>
        ) : null}
        {props.mountB ? (
          <div data-testid="surface-b">
            <HeaderSearchSlot
              tabId={TAB_B}
              testId={`header-search-slot-${TAB_B}`}
            />
            <ArtifactPanelSearchShell epicId={EPIC_B} tabId={TAB_B}>
              <div data-testid="tree-b">tree b</div>
            </ArtifactPanelSearchShell>
          </div>
        ) : null}
      </>
    );
  }

  function typeAndSettle(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
  }

  it("opening and typing search in A leaves B in browse state", () => {
    openArtifactsSearch(TAB_A, "");
    render(<DualSurfaceHarness mountA mountB />);

    expect(searchOpenInStore(TAB_A)).toBe(true);
    expect(searchOpenInStore(TAB_B)).toBe(false);
    expect(searchQueryInStore(TAB_B)).toBe("");

    const surfaceA = screen.getByTestId("surface-a");
    const surfaceB = screen.getByTestId("surface-b");
    const inputA = within(surfaceA).getByLabelText("Search artifacts");
    expect(within(surfaceB).queryByLabelText("Search artifacts")).toBeNull();
    expect(within(surfaceB).getByTestId("tree-b")).toBeTruthy();

    typeAndSettle(inputA, "auth");
    expect(searchQueryInStore(TAB_A)).toBe("auth");
    expect(searchOpenInStore(TAB_B)).toBe(false);
    expect(searchQueryInStore(TAB_B)).toBe("");
    expect(within(surfaceB).queryByLabelText("Search artifacts")).toBeNull();
  });

  it("portals each open tab's input into only that tab's header slot", () => {
    openArtifactsSearch(TAB_A, "a");
    openArtifactsSearch(TAB_B, "b");
    render(<DualSurfaceHarness mountA mountB />);

    const slotA = screen.getByTestId(`header-search-slot-${TAB_A}`);
    const slotB = screen.getByTestId(`header-search-slot-${TAB_B}`);
    const inputA = within(slotA).getByLabelText("Search artifacts");
    const inputB = within(slotB).getByLabelText("Search artifacts");

    expect(inputA).not.toBe(inputB);
    expect(slotA.contains(inputA)).toBe(true);
    expect(slotB.contains(inputB)).toBe(true);
    expect(slotA.contains(inputB)).toBe(false);
    expect(slotB.contains(inputA)).toBe(false);
    expect(screen.getAllByLabelText("Search artifacts")).toHaveLength(2);
    expect((inputA as HTMLInputElement).value).toBe("a");
    expect((inputB as HTMLInputElement).value).toBe("b");
  });

  it("unregistering A's slot cannot clear B's registered slot", () => {
    openArtifactsSearch(TAB_A, "a");
    openArtifactsSearch(TAB_B, "b");
    const { rerender } = render(<DualSurfaceHarness mountA mountB />);

    const slotBBefore = searchSlotInStore(TAB_B);
    expect(searchSlotInStore(TAB_A)).toBeTruthy();
    expect(slotBBefore).toBeTruthy();

    // Unmount only A: production-equivalent unregister of A's element.
    rerender(<DualSurfaceHarness mountA={false} mountB />);

    expect(searchSlotInStore(TAB_A)).toBeUndefined();
    expect(searchSlotInStore(TAB_B)).toBe(slotBBefore);
    expect(searchOpenInStore(TAB_B)).toBe(true);
    expect(searchQueryInStore(TAB_B)).toBe("b");
    expect(
      within(screen.getByTestId(`header-search-slot-${TAB_B}`)).getByLabelText(
        "Search artifacts",
      ),
    ).toBeTruthy();
  });

  it("closing search on A does not close B", () => {
    openArtifactsSearch(TAB_A, "auth");
    openArtifactsSearch(TAB_B, "other");
    render(<DualSurfaceHarness mountA mountB />);

    const surfaceA = screen.getByTestId("surface-a");
    fireEvent.click(within(surfaceA).getByTestId("epic-artifact-search-close"));

    expect(searchOpenInStore(TAB_A)).toBe(false);
    expect(searchQueryInStore(TAB_A)).toBe("");
    expect(searchOpenInStore(TAB_B)).toBe(true);
    expect(searchQueryInStore(TAB_B)).toBe("other");
    expect(within(surfaceA).queryByLabelText("Search artifacts")).toBeNull();
    expect(
      within(screen.getByTestId("surface-b")).getByLabelText(
        "Search artifacts",
      ),
    ).toBeTruthy();
  });

  it("opening a hit from A is bound to A's tabId", () => {
    openArtifactsSearch(TAB_A, "auth");
    openArtifactsSearch(TAB_B, "auth");
    render(<DualSurfaceHarness mountA mountB />);

    const surfaceA = screen.getByTestId("surface-a");
    const surfaceB = screen.getByTestId("surface-b");
    typeAndSettle(within(surfaceA).getByLabelText("Search artifacts"), "auth");
    typeAndSettle(within(surfaceB).getByLabelText("Search artifacts"), "auth");

    fireEvent.click(
      within(surfaceA).getByTestId("epic-artifact-search-result-a1"),
    );
    expect(harness.openMock).toHaveBeenCalledTimes(1);
    expect(harness.openMock).toHaveBeenCalledWith(TAB_A, {
      id: "a1",
      type: "ticket",
    });
  });
});
