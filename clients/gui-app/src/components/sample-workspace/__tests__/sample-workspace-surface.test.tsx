import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEditFirewall } from "@/components/layout-editor/canvas/edit-firewall";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import { SAMPLE_TURNS } from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

// Every accessor a piece could reach a host through resolves to a client that
// never settles: the body must never depend on a real answer to render.
const recordingClient = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "string" && prop !== "then"
            ? (..._args: unknown[]) => new Promise(() => undefined)
            : undefined,
      },
    ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: () => recordingClient,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => recordingClient,
  useOptionalHostClient: () => recordingClient,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
// The dock's own panels are the REAL ones now (L-98), so this render reaches
// the same host boundary every other dock suite fakes away: the agent stop
// button's `HostRuntimeProvider` hooks and the managed half's RPCs. The app
// mounts both app-wide (`traycer-app.tsx`), so the fake is about this
// standalone render, not about what the sample workspace needs to exist.
vi.mock("@/components/chat/agent-stop-button", () => ({
  AgentStopButton: (props: { readonly label: string }) => (
    <button type="button">{props.label}</button>
  ),
}));
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

function Probe(): ReactNode {
  return (
    <span data-testid="sample-probe">
      {useSampleScene() ? "sample" : "real"}
    </span>
  );
}

function renderBody() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return render(
    // The app column, exactly as `app-shell.tsx` writes it: the sample tab
    // renders inside it, so it is the element the edit firewall installs on and
    // the one ancestor between a sample control and the document.
    <div data-layout-column data-testid="column">
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <SampleSceneProvider>
                <Probe />
                <SampleWorkspaceBody />
              </SampleSceneProvider>
            </TooltipProvider>
          </LazyMotion>
        </QueryClientProvider>
      </RunnerHostProvider>
    </div>,
  );
}

/**
 * The sample tab exists only for a live session, so every canvas assertion
 * below renders into one.
 *
 * The NAME (`data-layout-region`) is on the element at rest too since L-129 -
 * a right-click has to resolve a region while the user is only using the app.
 * What a session decides is the REGISTRATION and the decoration that hangs off
 * it, which is what the canvas hovers, selects and drags.
 */
function renderSession() {
  const rendered = renderBody();
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
  return rendered;
}

function regionNode(regionId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-layout-region="${regionId}"]`,
  );
  if (node === null) throw new Error(`no ${regionId} region on the canvas`);
  return node;
}

/**
 * A stand-in for what a pointer actually lands on: the innermost element the
 * region draws. jsdom does no hit testing, so the assertion a test can make is
 * the one the canvas itself makes of a hit - `closest("[data-layout-region]")`.
 */
function innermost(node: HTMLElement): HTMLElement {
  let deepest = node;
  while (deepest.firstElementChild instanceof HTMLElement)
    deepest = deepest.firstElementChild;
  return deepest;
}

beforeEach(() => {
  localStorage.clear();
  // jsdom does no layout: every element measures as the same reachable box.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(20, 20, 40, 24),
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => {
    const measured = new DOMRect(20, 20, 40, 24);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  });
  useThemeLibraryStore.setState({ panelAnimations: false });
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({
    instances: new Map(),
    dockMode: "right",
    lockedBy: "none",
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SampleWorkspaceBody - content", () => {
  it("renders a scrollable transcript of every sample turn, with its tool activity row", () => {
    renderBody();

    expect(screen.getByLabelText("Sample conversation")).not.toBeNull();
    expect(document.querySelectorAll("[data-sample-turn]")).toHaveLength(
      SAMPLE_TURNS.length,
    );
    expect(
      document.querySelectorAll('[data-layout-region="toolActivity"]'),
    ).toHaveLength(1);
  });

  // L-98: the dock rows are the REAL panels fed sample data, not look-alike
  // headers. Each assertion below is something only the real panel draws -
  // the changed-files COUNT with its header actions, the collapsible agents
  // and background panels, the pinned todo and the queued message - so a
  // return to hand-drawn headers fails every one of them.
  it("mounts the real dock panels with sample data, the composer, and the sample context chip", () => {
    renderBody();

    const changes = screen.getByTestId("accumulated-changes-panel");
    expect(changes.textContent).toContain("3 files changed");
    expect(screen.getByTestId("accumulated-review-all")).not.toBeNull();
    expect(screen.getByTestId("accumulated-undo-all")).not.toBeNull();
    // Collapsible, which the old `FileChangeHeader` stand-in never was.
    expect(changes.hasAttribute("data-closed")).toBe(true);

    const agents = screen.getByTestId("active-agents-panel");
    expect(agents.textContent).toContain("2 running");
    const background = screen.getByTestId("background-items-panel");
    expect(background.textContent).toContain("running");
    expect(screen.getByTestId("pinned-todo-panel")).not.toBeNull();
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();

    expect(screen.getByText("Describe the next change…")).not.toBeNull();
    // No second "Sample workspace" caption in the workspace row: the sample
    // notice banner above the canvas is the one caption now (design craft 2.3).
    expect(screen.getByTestId("context-usage-meter")).not.toBeNull();
  });

  it("draws a minimap from the sample turns", () => {
    renderBody();

    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(
      screen.getAllByTestId("chat-turn-minimap-tick").length,
    ).toBeGreaterThan(0);
  });

  // L-116: the mic slot draws nothing without a dictation control, whatever
  // Microphone is set to, so a Shown microphone had no chip on the canvas to
  // hover, select or drag - while the inspector's own specimen drew one.
  it("draws the mic chip from the sample dictation control", () => {
    renderBody();

    expect(screen.getByLabelText("Start voice input")).not.toBeNull();
  });
});

/**
 * L-131 and LV2-01. The sample scene wrapped its dock, its transcript, its
 * minimap and (inside `ComposerToolbar`) its toolbar in `inert`, which removes
 * a subtree from hit testing - so not one region on the chat pane could be
 * hovered, selected by pointing or dragged, which is the whole model (P3,
 * L-01). The edit firewall is the one mechanism that keeps sample content from
 * acting, and these three assertions are its two halves: the pointer reaches
 * the region, and the gesture goes no further than the column.
 */
describe("SampleWorkspaceBody - pointable, under the edit firewall", () => {
  afterEach(() => {
    useLayoutEditorStore.getState().endSession();
  });

  it("puts no inert anywhere in the sample scene", () => {
    renderSession();

    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    // The scroller keeps scrolling natively, which is the one passivity the
    // scene never had to buy (L-17).
    expect(
      screen.getByLabelText("Sample conversation").hasAttribute("inert"),
    ).toBe(false);
  });

  it("resolves a hit on every chat-pane region back to that region", () => {
    renderSession();

    // Every region the live audit found unpointable, plus the mic LV2-03 kept
    // off the canvas entirely.
    for (const regionId of [
      "minimap",
      "contextUsage",
      "changedFiles",
      "runningAgents",
      "background",
      "attachImage",
      "access",
      "model",
      "mic",
    ]) {
      const node = regionNode(regionId);
      expect(node.closest("[inert]")).toBeNull();
      expect(innermost(node).closest("[data-layout-region]")).toBe(node);
    }
  });

  it("lets the firewall, not the markup, swallow a click on a region", () => {
    renderSession();
    const heard: string[] = [];
    const target = innermost(regionNode("access"));
    target.addEventListener("click", () => heard.push("access"));

    const teardown = installEditFirewall({
      column: screen.getByTestId("column"),
      focusTarget: () => null,
    });
    const delivered = target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual([]);
    expect(delivered).toBe(false);

    // Control: the element IS reachable: without the firewall the same click
    // lands on it, which is what the deleted `inert` made impossible.
    teardown();
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(heard).toEqual(["access"]);
  });
});

/**
 * L-144. The dock's pills and rows and the minimap answered a right-click with
 * nothing, because the quick-verb menu was mounted by five call sites and none
 * of them was here - while this IS the canvas the editor opens (L-87), so it is
 * the chrome a user customizing the composer actually points at.
 *
 * Every case goes through the real surface rather than a stand-in cluster: the
 * region names come from `useLayoutRegion` as the app writes them, and the
 * menu is resolved from the element a pointer would land on.
 */
describe("SampleWorkspaceBody - quick verbs on every pointable region", () => {
  const QUICK_VERB_ID = /^layout-quick-verb-(.+)-(hide|show|chip|full)$/;

  afterEach(() => {
    useLayoutEditorStore.getState().endSession();
  });

  /** The regions the menu currently on screen offers verbs for. */
  function menuNames(): ReadonlyArray<string> {
    const named = screen.queryAllByTestId(QUICK_VERB_ID).map((item) => {
      const match = QUICK_VERB_ID.exec(item.getAttribute("data-testid") ?? "");
      return match === null ? "" : match[1];
    });
    return [...new Set(named)];
  }

  function rightClickRegion(regionId: string): void {
    fireEvent.contextMenu(innermost(regionNode(regionId)));
  }

  it("offers a full dock row's own verbs, and only its own, at rest", () => {
    renderBody();
    expect(useLayoutEditorStore.getState().session).toBeNull();

    rightClickRegion("changedFiles");

    expect(menuNames()).toEqual(["changedFiles"]);
  });

  it("offers the row beside it its own verbs, from the same one root", () => {
    renderBody();

    rightClickRegion("todo");

    expect(menuNames()).toEqual(["todo"]);
  });

  it("offers a dock row's verbs inside a session too", () => {
    renderSession();

    rightClickRegion("runningAgents");

    expect(menuNames()).toEqual(["runningAgents"]);
  });

  // The pills specifically, which is what the owner asked for (L-115): a
  // chip-sized member stands in the strip above the composer, not in the
  // frame, so it is a different cluster and needs its own root.
  it("offers a compact pill's verbs", () => {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { changedFiles: { size: "chip" } },
    });
    renderBody();
    expect(screen.getByTestId("chat-dock-chip-filesChanged")).not.toBeNull();

    rightClickRegion("changedFiles");

    expect(menuNames()).toEqual(["changedFiles"]);
  });

  // G3-10: the timestamps, the activity rows and the minimap share ONE menu
  // around the transcript, resolved from the region under the pointer. No item
  // in the transcript owns a trigger of its own.
  it("offers a timestamp's verbs from the transcript's one menu", () => {
    renderBody();

    const stamp = screen.getAllByTestId("chat-message-timestamp")[0];
    fireEvent.contextMenu(stamp);

    expect(menuNames()).toEqual(["timestamps"]);
  });

  it("offers an activity row's verbs from the transcript's one menu", () => {
    renderBody();

    rightClickRegion("toolActivity");

    expect(menuNames()).toEqual(["toolActivity"]);
  });

  it("opens no menu on plain reply text, which is content rather than a region", () => {
    renderBody();

    const replies = document.querySelectorAll<HTMLElement>(
      "[data-sample-turn] [data-layout-passive]",
    );
    fireEvent.contextMenu(innermost(replies[replies.length - 1]));

    expect(menuNames()).toEqual([]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("mounts no menu trigger inside the transcript itself", () => {
    renderBody();

    expect(
      screen
        .getByLabelText("Sample conversation")
        .querySelectorAll("[data-slot='context-menu-trigger']"),
    ).toHaveLength(0);
  });

  it("offers the minimap's verbs, at rest and in a session", () => {
    renderBody();

    rightClickRegion("minimap");
    expect(menuNames()).toEqual(["minimap"]);

    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });
    rightClickRegion("minimap");

    expect(menuNames()).toEqual(["minimap"]);
  });

  /**
   * The other half of "in a session": the firewall swallows `contextmenu`
   * everywhere except on a named region that has a trigger listening
   * (L-129), and the wrappers above are what make that second half true for
   * these regions. Dispatched as a real bubbling event rather than through
   * `fireEvent`, because the firewall listens in the capture phase on the
   * column and `stopImmediatePropagation` is what a synthetic dispatch would
   * step over. The control - a press the firewall DOES swallow - is
   * `edit-firewall.test.ts`'s own, said there once rather than restated here.
   */
  it("reaches the minimap's trigger through the edit firewall", () => {
    renderSession();
    const teardown = installEditFirewall({
      column: screen.getByTestId("column"),
      focusTarget: () => null,
    });

    act(() => {
      innermost(regionNode("minimap")).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });

    expect(menuNames()).toEqual(["minimap"]);
    teardown();
  });
});

describe("SampleWorkspaceBody - a hidden dock member's ghost", () => {
  afterEach(() => {
    useLayoutEditorStore.getState().endSession();
  });

  // A member that is Hidden AND Chip draws nothing at rest and materialises
  // while the editor points at it (L-14). The shape it materialises IN is the
  // one it would take if it were shown, which for a Chip-sized member is the
  // pill - so the picture the user judges their own setting by is the setting.
  //
  // It drew a full ROW instead: `folded` was derived from the stored `shown`
  // alone while `planDockRow` asked `shown || ghost`, so the ghost slipped
  // past the fold and landed in the joined frame. One derivation now
  // (`dockMemberFolded`), read by this host and by the real tile.
  it("materialises a Hidden + Chip member as its chip, not as a full row", () => {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { changedFiles: { shown: "hidden", size: "chip" } },
    });
    renderBody();

    // Hidden and unpointed-at: neither shape is on screen.
    expect(screen.queryByTestId("chat-dock-chip-filesChanged")).toBeNull();
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
      useLayoutEditorStore.getState().select("changedFiles");
    });

    expect(screen.getByTestId("chat-dock-chip-filesChanged")).not.toBeNull();
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
  });
});

describe("SampleWorkspaceBody - a Hidden minimap", () => {
  // Hidden reads as absent, the way the real chat draws it, until the editor
  // points at the region (L-14): the sample canvas keeps no "Hidden" caption
  // in the minimap's place.
  it("draws nothing and no placeholder at rest, materialises under the pointer, and goes again after", () => {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { minimap: { shown: "hidden" } },
    });
    renderSession();

    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHovered("minimap");
    });

    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHovered(null);
    });

    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });
});

/**
 * The passive dim puts `opacity` and `filter` on whatever carries the marker,
 * so it is correct only on a leaf: a box that exists (a `contents` wrapper has
 * none, which makes the dim a silent no-op) and that holds no region (an
 * ancestor's `filter` dims the editable chrome under it, inverting the signal
 * the editor exists to give). Whether an element is a leaf is a fact about the
 * tree it sits in, so it is asserted on the mounted canvas rather than
 * counted in source text.
 */
describe("SampleWorkspaceBody - the passive dim's markers", () => {
  it("sit only on boxes that exist and that hold no region", () => {
    renderSession();
    // Model pointed at brings its picker's parts onto the canvas too.
    act(() => {
      useLayoutEditorStore.getState().select("model");
    });

    const markers = document.querySelectorAll<HTMLElement>(
      "[data-layout-passive], [data-layout-passive-members]",
    );
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.classList.contains("contents")).toBe(false);
      // A boolean, so a failure does not pretty-print a whole subtree.
      expect(marker.querySelector("[data-layout-region]") !== null).toBe(false);
    }
  });
});

describe("SampleWorkspaceBody - sample labelling", () => {
  afterEach(() => {
    useLayoutEditorStore.getState().endSession();
  });

  it("SampleSceneProvider reads 'sample' exactly while a session is live", () => {
    renderBody();
    expect(screen.getByTestId("sample-probe").textContent).toBe("real");

    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });
    expect(screen.getByTestId("sample-probe").textContent).toBe("sample");

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });
    expect(screen.getByTestId("sample-probe").textContent).toBe("real");
  });
});
