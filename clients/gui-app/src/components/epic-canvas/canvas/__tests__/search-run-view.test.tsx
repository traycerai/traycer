import "../../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Command, CommandList } from "@/components/ui/command";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { OpenTileIntoTargetGroupArgs } from "@/lib/commands/actions/open-into-target";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { SearchRunTarget } from "@/lib/commands/sources/open/search-target";
import type { UseWorkspaceSearchTextArgs } from "@/hooks/workspace/use-workspace-search-text-query";

// Only the fields the component actually reads off a query result. `data` is
// `unknown` so a test can hand it any response shape (vi.mock factories are
// untyped, so the real hook's return type never has to be reconstructed).
interface MockQueryResult {
  readonly data: unknown;
  readonly isError: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
}

interface ResolvedArtifactFixture {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}

interface MockState {
  readonly openTileIntoTargetGroup: Mock<
    (args: OpenTileIntoTargetGroupArgs) => void
  >;
  readonly setReveal: Mock<
    (tabId: string, contentId: string, line: number, col: number | null) => void
  >;
  readonly toast: Mock<(message: string) => void>;
  // Both targets now run through `workspace.searchText`; the mock returns the
  // code result for a `{ root }` reference and the artifact result for a
  // `{ kind: "epic-artifacts" }` reference.
  codeResult: MockQueryResult;
  artifactResult: MockQueryResult;
  // The args the component last passed to the (mocked) text-search hook for each
  // reference kind, so a test can assert options reach the request/query key.
  lastCodeArgs: UseWorkspaceSearchTextArgs | null;
  lastArtifactArgs: UseWorkspaceSearchTextArgs | null;
  // `<root>||<query>` (code) / `<query>` (artifact) recorded for every render
  // where the hook would issue an RPC (enabled + non-empty query), so a
  // debounce/coalescing test can assert intermediate keystrokes never fired.
  readonly codeIssued: string[];
  readonly artifactIssued: string[];
  // Logical-artifact-path -> authoritative identity, the live-Yjs resolution a
  // real artifact open re-runs; an absent path models a stale/deleted result.
  artifactIndex: Record<string, ResolvedArtifactFixture>;
  // Records keys that bubbled PAST the cmdk Command to the outer wrapper, so a
  // test can assert cmdk isolation (Enter/arrows stopped, Escape allowed).
  readonly outerKeyDown: Mock<(key: string) => void>;
}

const IDLE: MockQueryResult = { data: undefined, isError: false, error: null };

const state = vi.hoisted<MockState>(() => ({
  openTileIntoTargetGroup: vi.fn<(args: OpenTileIntoTargetGroupArgs) => void>(),
  setReveal:
    vi.fn<
      (
        tabId: string,
        contentId: string,
        line: number,
        col: number | null,
      ) => void
    >(),
  toast: vi.fn<(message: string) => void>(),
  codeResult: { data: undefined, isError: false, error: null },
  artifactResult: { data: undefined, isError: false, error: null },
  lastCodeArgs: null,
  lastArtifactArgs: null,
  codeIssued: [],
  artifactIssued: [],
  artifactIndex: {},
  outerKeyDown: vi.fn<(key: string) => void>(),
}));

vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "default-host",
}));
vi.mock("@/hooks/workspace/use-workspace-search-text-query", () => ({
  useWorkspaceSearchText: (args: UseWorkspaceSearchTextArgs) => {
    const ref = args.reference;
    const isArtifact = ref !== null && "kind" in ref;
    const nonEmpty = args.enabled && args.query.trim().length > 0;
    if (isArtifact) {
      state.lastArtifactArgs = args;
      if (nonEmpty) state.artifactIssued.push(args.query);
      return state.artifactResult;
    }
    state.lastCodeArgs = args;
    const root = ref !== null && "root" in ref ? ref.root : "";
    if (nonEmpty) state.codeIssued.push(`${root}||${args.query}`);
    return state.codeResult;
  },
}));
vi.mock("@/lib/commands/sources/open/artifact-path-resolver", () => ({
  useArtifactPathResolver: () => (logicalPath: string) =>
    state.artifactIndex[logicalPath] ?? null,
}));
vi.mock("sonner", () => ({ toast: (message: string) => state.toast(message) }));
vi.mock("@/lib/commands/actions", () => ({
  openTileIntoTargetGroup: state.openTileIntoTargetGroup,
}));
vi.mock("@/stores/epics/canvas/workspace-file-reveal-store", () => ({
  setWorkspaceFileRevealTarget: (
    tabId: string,
    contentId: string,
    line: number,
    col: number | null,
  ) => state.setReveal(tabId, contentId, line, col),
}));

import { SearchRunView } from "@/components/epic-canvas/canvas/search-run-view";

const navigateNestedFocusSpy = vi.fn<NavigateNestedFocus>();

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    navigateNestedFocus: navigateNestedFocusSpy,
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

const CODE_TARGET: SearchRunTarget = {
  kind: "code",
  hostId: "host-a",
  root: "/ws",
};

// The <Command> onKeyDown fires only for keys that actually reach cmdk (i.e.
// were NOT stopped at a focused control), so a test can assert isolation. cmdk
// forwards this prop to its root, exactly as the real pane opener passes its own
// onKeyDown.
function renderView(target: SearchRunTarget, query: string) {
  return render(
    <Command
      shouldFilter={false}
      onKeyDown={(event) => state.outerKeyDown(event.key)}
    >
      <PaletteQueryProvider value={query}>
        <CommandList>
          <SearchRunView target={target} ctx={CTX} />
        </CommandList>
      </PaletteQueryProvider>
    </Command>,
  );
}

function codeReady(results: ReadonlyArray<unknown>, truncated: boolean) {
  return {
    data: {
      epicId: "epic-1",
      root: "/ws",
      outcome: "ready",
      truncated,
      results,
    },
    isError: false,
    error: null,
  };
}

beforeEach(() => {
  state.codeResult = IDLE;
  state.artifactResult = IDLE;
  state.lastCodeArgs = null;
  state.lastArtifactArgs = null;
  state.codeIssued.length = 0;
  state.artifactIssued.length = 0;
  state.artifactIndex = {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SearchRunView - code target", () => {
  it("prompts to type when the query is empty", () => {
    renderView(CODE_TARGET, "");
    expect(screen.getByText(/type to search/i)).not.toBeNull();
  });

  it("renders matches and opens the file revealing the match location", () => {
    state.codeResult = codeReady(
      [
        {
          relPath: "src/a.ts",
          lineNumber: 3,
          column: 5,
          preview: {
            text: "const a = 1",
            ranges: [{ startByte: 0, endByte: 5 }],
          },
        },
      ],
      false,
    );
    renderView(CODE_TARGET, "const");

    const option = screen.getByRole("option");
    fireEvent.click(option);

    // The reveal is recorded BEFORE the open, with the match's 1-based line/col.
    expect(state.setReveal).toHaveBeenCalledTimes(1);
    const reveal = state.setReveal.mock.calls[0];
    expect(reveal[0]).toBe("tab-1");
    expect(reveal[2]).toBe(3);
    expect(reveal[3]).toBe(5);

    const opened = state.openTileIntoTargetGroup.mock.calls.at(0)?.[0];
    expect(opened?.groupId).toBe("group-1");
    expect(opened?.ref.type).toBe("workspace-file");
    expect(opened?.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });

  it("shows a distinct message for an invalid regex", () => {
    state.codeResult = {
      data: {
        epicId: "epic-1",
        root: "/ws",
        outcome: "invalid_regex",
        truncated: false,
        results: [],
      },
      isError: false,
      error: null,
    };
    renderView(CODE_TARGET, "a(");
    expect(screen.getByText(/invalid regular expression/i)).not.toBeNull();
  });

  it("shows a distinct message when the root is no longer available", () => {
    state.codeResult = {
      data: {
        epicId: "epic-1",
        root: "/ws",
        outcome: "root_unavailable",
        truncated: false,
        results: [],
      },
      isError: false,
      error: null,
    };
    renderView(CODE_TARGET, "foo");
    expect(screen.getByText(/no longer available/i)).not.toBeNull();
  });

  it("degrades gracefully when the host does not support text search", () => {
    state.codeResult = {
      data: undefined,
      isError: true,
      error: { code: "E_HOST_UNSUPPORTED", message: "no" },
    };
    renderView(CODE_TARGET, "foo");
    expect(screen.getByText(/isn.t available on this host/i)).not.toBeNull();
  });

  it("drops a late payload whose echoed root no longer matches the target", () => {
    // The response echoes a DIFFERENT root than the current target, so it is a
    // stale result for a previous selection and must not render.
    state.codeResult = {
      data: {
        epicId: "epic-1",
        root: "/other-ws",
        outcome: "ready",
        truncated: false,
        results: [
          {
            relPath: "stale.ts",
            lineNumber: 1,
            column: 1,
            preview: { text: "stale", ranges: [] },
          },
        ],
      },
      isError: false,
      error: null,
    };
    renderView(CODE_TARGET, "foo");
    expect(screen.queryByText("stale.ts")).toBeNull();
    // Falls back to the in-flight state rather than showing the stale match.
    expect(screen.getByRole("status")).not.toBeNull();
  });

  it("exposes accessible, toggleable search options", () => {
    state.codeResult = codeReady([], false);
    renderView(CODE_TARGET, "foo");
    const regex = screen.getByRole("button", {
      name: /use regular expression/i,
    });
    expect(regex.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(regex);
    expect(regex.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /match case/i })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /match whole word/i }),
    ).not.toBeNull();
    // The include/exclude glob fields are labeled, focusable text inputs.
    expect(
      screen.getByRole("textbox", { name: /files to include/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: /files to exclude/i }),
    ).not.toBeNull();
  });

  it("normalizes comma-separated globs into the request and drops empties", () => {
    state.codeResult = codeReady([], false);
    renderView(CODE_TARGET, "foo");
    fireEvent.change(
      screen.getByRole("textbox", { name: /files to include/i }),
      { target: { value: "*.ts, src/** ,, " } },
    );
    expect(state.lastCodeArgs?.options.includeGlobs).toEqual([
      "*.ts",
      "src/**",
    ]);
    // Whitespace / stray separators impose no filter.
    fireEvent.change(
      screen.getByRole("textbox", { name: /files to exclude/i }),
      { target: { value: "   ,  " } },
    );
    expect(state.lastCodeArgs?.options.excludeGlobs).toEqual([]);
  });

  it("re-issues the request when an option changes (no stale prior-glob render)", () => {
    state.codeResult = codeReady([], false);
    renderView(CODE_TARGET, "foo");
    // Every option feeds the request and thus the TanStack query key, so a
    // change mints a new key: a response for the previous glob settings lands
    // under the old key and can never render for the new one.
    fireEvent.change(
      screen.getByRole("textbox", { name: /files to include/i }),
      { target: { value: "*.ts" } },
    );
    expect(state.lastCodeArgs?.options.includeGlobs).toEqual(["*.ts"]);
    fireEvent.click(
      screen.getByRole("button", { name: /use regular expression/i }),
    );
    expect(state.lastCodeArgs?.options.regex).toBe(true);
    expect(state.lastCodeArgs?.options.includeGlobs).toEqual(["*.ts"]);
  });

  it("isolates typing keys from cmdk but lets Escape bubble for back/return", () => {
    state.codeResult = codeReady(
      [
        {
          relPath: "src/a.ts",
          lineNumber: 1,
          column: 1,
          preview: { text: "hit", ranges: [] },
        },
      ],
      false,
    );
    renderView(CODE_TARGET, "foo");
    const include = screen.getByRole("textbox", { name: /files to include/i });

    // Enter/ArrowDown must NOT reach cmdk (no result opened; nothing bubbles to
    // the outer wrapper) so the user can type and move the caret freely.
    fireEvent.keyDown(include, { key: "Enter" });
    fireEvent.keyDown(include, { key: "ArrowDown" });
    expect(state.openTileIntoTargetGroup).not.toHaveBeenCalled();
    expect(state.outerKeyDown).not.toHaveBeenCalledWith("Enter");
    expect(state.outerKeyDown).not.toHaveBeenCalledWith("ArrowDown");

    // Escape is intentionally allowed through so the opener can back out.
    fireEvent.keyDown(include, { key: "Escape" });
    expect(state.outerKeyDown).toHaveBeenCalledWith("Escape");
  });

  it("resets options when the target sub-page remounts (target switch / back)", () => {
    state.codeResult = codeReady([], false);
    const tree = (runKey: string) => (
      <Command shouldFilter={false}>
        <PaletteQueryProvider value="foo">
          <CommandList>
            <SearchRunView key={runKey} target={CODE_TARGET} ctx={CTX} />
          </CommandList>
        </PaletteQueryProvider>
      </Command>
    );
    const { rerender } = render(tree("run-a"));
    fireEvent.click(
      screen.getByRole("button", { name: /use regular expression/i }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /files to include/i }),
      { target: { value: "*.ts" } },
    );
    expect(state.lastCodeArgs?.options.regex).toBe(true);

    // A different key remounts the sub-page, exactly as the pane opener does on
    // a target change or a back-then-re-enter, so option state starts fresh.
    rerender(tree("run-b"));
    expect(
      screen
        .getByRole("button", { name: /use regular expression/i })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: /files to include/i,
      }).value,
    ).toBe("");
  });
});

describe("SearchRunView - artifact target (workspace.searchText)", () => {
  const ARTIFACT_TARGET: SearchRunTarget = { kind: "artifact" };

  function artifactMatch(relPath: string) {
    return {
      relPath,
      lineNumber: 2,
      column: 1,
      preview: { text: `${relPath} body`, ranges: [] },
    };
  }

  function artifactResponse(
    outcome: string,
    results: ReadonlyArray<unknown>,
    truncated: boolean,
  ) {
    return {
      data: {
        epicId: "epic-1",
        source: { kind: "epic-artifacts" },
        outcome,
        truncated,
        results,
      },
      isError: false,
      error: null,
    };
  }

  it("renders the SAME five controls as the code target", () => {
    state.artifactResult = artifactResponse("ready", [], false);
    renderView(ARTIFACT_TARGET, "ticket");
    expect(screen.getByRole("button", { name: /match case/i })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /match whole word/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /use regular expression/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: /files to include/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: /files to exclude/i }),
    ).not.toBeNull();
  });

  it("searches the typed epic-artifacts source and sends the five options", () => {
    state.artifactResult = artifactResponse("ready", [], false);
    renderView(ARTIFACT_TARGET, "ticket");
    fireEvent.click(
      screen.getByRole("button", { name: /use regular expression/i }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /files to include/i }),
      { target: { value: ".md" } },
    );
    // The artifact target rides workspace.searchText with the opaque source
    // selector (never epic.searchArtifacts), and every option reaches the key.
    expect(state.lastArtifactArgs?.reference).toEqual({
      kind: "epic-artifacts",
    });
    expect(state.lastArtifactArgs?.options.regex).toBe(true);
    expect(state.lastArtifactArgs?.options.includeGlobs).toEqual(["*.md"]);
  });

  it("opens a match through authoritative live id + kind, never the mirror", () => {
    state.artifactIndex = {
      "tickets/known": { id: "art-1", kind: "ticket", title: "Known" },
    };
    state.artifactResult = artifactResponse(
      "ready",
      [artifactMatch("tickets/known")],
      false,
    );
    renderView(ARTIFACT_TARGET, "body");

    fireEvent.click(screen.getByRole("option"));
    const opened = state.openTileIntoTargetGroup.mock.calls.at(0)?.[0];
    expect(opened?.ref.id).toBe("art-1");
    expect(opened?.ref.type).toBe("ticket");
    expect(opened?.ref.name).toBe("Known");
    expect(opened?.groupId).toBe("group-1");
    // Authoritative artifact open - NOT a workspace-file reveal of the mirror.
    expect(state.setReveal).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("fails safe when re-resolution returns null (stale/deleted OR ambiguous)", () => {
    // A path with no live identity - a deleted artifact, or an AMBIGUOUS path two
    // live artifacts share (which the resolver fails closed to `null`) - both
    // reach the component as a null resolution. The result must never open an
    // artifact AND never fall through to a workspace-file (mirror) reveal.
    state.artifactResult = artifactResponse(
      "ready",
      [artifactMatch("tickets/gone")],
      false,
    );
    renderView(ARTIFACT_TARGET, "body");

    fireEvent.click(screen.getByRole("option"));
    expect(state.openTileIntoTargetGroup).not.toHaveBeenCalled();
    expect(state.setReveal).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it("drops a code (root) response for the artifact target (source echo)", () => {
    // A payload echoing `root` instead of the artifact source is stale here.
    state.artifactResult = {
      data: {
        epicId: "epic-1",
        root: "/ws",
        outcome: "ready",
        truncated: false,
        results: [artifactMatch("tickets/known")],
      },
      isError: false,
      error: null,
    };
    renderView(ARTIFACT_TARGET, "body");
    expect(screen.queryByRole("option")).toBeNull();
    // Falls back to the in-flight state rather than rendering the wrong source.
    expect(screen.getByRole("status")).not.toBeNull();
  });

  it("renders the artifact root_unavailable state", () => {
    state.artifactResult = artifactResponse("root_unavailable", [], false);
    renderView(ARTIFACT_TARGET, "body");
    expect(screen.getByText(/aren.t available yet/i)).not.toBeNull();
  });

  it("renders invalid_regex for the artifact target", () => {
    state.artifactResult = artifactResponse("invalid_regex", [], false);
    renderView(ARTIFACT_TARGET, "body");
    expect(screen.getByText(/invalid regular expression/i)).not.toBeNull();
  });

  it("marks truncation for the artifact target", () => {
    state.artifactIndex = {
      "tickets/known": { id: "art-1", kind: "ticket", title: "Known" },
    };
    state.artifactResult = artifactResponse(
      "ready",
      [artifactMatch("tickets/known")],
      true,
    );
    renderView(ARTIFACT_TARGET, "body");
    expect(screen.getByText(/showing the first matches/i)).not.toBeNull();
  });

  it("degrades on an old host that lacks workspace.searchText", () => {
    state.artifactResult = {
      data: undefined,
      isError: true,
      error: { code: "E_HOST_UNSUPPORTED", message: "nope" },
    };
    renderView(ARTIFACT_TARGET, "body");
    expect(screen.getByText(/isn.t available on this host/i)).not.toBeNull();
  });
});

describe("SearchRunView - query debounce", () => {
  // Comfortably past SEARCH_QUERY_DEBOUNCE_MS (150ms) so the timer settles.
  const DEBOUNCE_ADVANCE_MS = 200;
  const CODE_TARGET_B: SearchRunTarget = {
    kind: "code",
    hostId: "host-a",
    root: "/ws-b",
  };

  // Keyed on the target root so a target switch REMOUNTS, exactly as the pane
  // opener does (its sub-page id changes), exercising the unmount-clears-timer
  // path for the scope test.
  function codeTree(query: string, target: SearchRunTarget) {
    return (
      <Command shouldFilter={false}>
        <PaletteQueryProvider value={query}>
          <CommandList>
            <SearchRunView
              key={target.kind === "code" ? target.root : "artifact"}
              target={target}
              ctx={CTX}
            />
          </CommandList>
        </PaletteQueryProvider>
      </Command>
    );
  }

  function artifactTree(query: string) {
    return (
      <Command shouldFilter={false}>
        <PaletteQueryProvider value={query}>
          <CommandList>
            <SearchRunView target={{ kind: "artifact" }} ctx={CTX} />
          </CommandList>
        </PaletteQueryProvider>
      </Command>
    );
  }

  it("coalesces rapid typing into ONE settled code query", () => {
    vi.useFakeTimers();
    try {
      state.codeResult = codeReady([], false);
      const { rerender } = render(codeTree("", CODE_TARGET));
      rerender(codeTree("n", CODE_TARGET));
      rerender(codeTree("ne", CODE_TARGET));
      rerender(codeTree("nee", CODE_TARGET));
      // Nothing settled yet: no intermediate keystroke reached the hook / RPC.
      expect(state.codeIssued).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
      });
      expect(state.lastCodeArgs?.query).toBe("nee");
      expect(state.codeIssued).toEqual(["/ws||nee"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid typing into ONE settled artifact query", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(artifactTree(""));
      rerender(artifactTree("t"));
      rerender(artifactTree("ti"));
      rerender(artifactTree("tic"));
      expect(state.artifactIssued).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
      });
      expect(state.lastArtifactArgs?.query).toBe("tic");
      expect(state.artifactIssued).toEqual(["tic"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears immediately when the query empties (no debounce on clear)", () => {
    vi.useFakeTimers();
    try {
      state.codeResult = codeReady([], false);
      const { rerender } = render(codeTree("nee", CODE_TARGET));
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
      });
      expect(state.lastCodeArgs?.query).toBe("nee");
      // Clearing takes effect WITHOUT advancing timers - back/clear is instant.
      rerender(codeTree("", CODE_TARGET));
      expect(state.lastCodeArgs?.query).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pending debounce cannot fire into a later target/scope", () => {
    vi.useFakeTimers();
    try {
      state.codeResult = codeReady([], false);
      // Mount empty, then type - so "nee" is a PENDING debounce, not an
      // immediate mount-time query.
      const { rerender } = render(codeTree("", CODE_TARGET));
      rerender(codeTree("nee", CODE_TARGET));
      // Switch target before the debounce settles; the remount clears the old
      // timer, so "nee" never issues for the old root.
      rerender(codeTree("xyz", CODE_TARGET_B));
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
      });
      expect(state.codeIssued).not.toContain("/ws||nee");
      expect(state.codeIssued).toContain("/ws-b||xyz");
    } finally {
      vi.useRealTimers();
    }
  });
});
