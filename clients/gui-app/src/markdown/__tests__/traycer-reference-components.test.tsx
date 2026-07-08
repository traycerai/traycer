import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const OPEN_EPIC_ID = "epic-open";

// A fake open-epic handle. The hook only reads `handle.epicId` and
// `handle.store.getState()` (which is fed straight into the mocked
// `epicNodeRefForNodeId`), so an empty state object is enough.
let mockHandle: { epicId: string; store: { getState: () => object } } | null = {
  epicId: OPEN_EPIC_ID,
  store: { getState: () => ({}) },
};

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => mockHandle,
}));

let mockActiveHostId: string | null = "active-host-1";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockActiveHostId,
}));

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

// `epicNodeRefForNodeId` resolves a same-epic node id into a ref (or null). The
// test maps a handful of known ids; everything else resolves to null.
const epicNodeRefForNodeId = vi.fn(
  (_state: object, nodeId: string, fallbackHostId: string) => {
    if (nodeId === "spec-1") {
      return {
        id: "spec-1",
        instanceId: "inst-spec",
        type: "spec",
        name: "Spec One",
        hostId: fallbackHostId,
      };
    }
    if (nodeId === "ticket-1") {
      return {
        id: "ticket-1",
        instanceId: "inst-ticket",
        type: "ticket",
        name: "Ticket One",
        hostId: fallbackHostId,
      };
    }
    if (nodeId === "chat-1") {
      return {
        id: "chat-1",
        instanceId: "inst-chat",
        type: "chat",
        name: "Chat One",
        hostId: fallbackHostId,
      };
    }
    return null;
  },
);

vi.mock("@/lib/epic-selectors", () => ({
  epicNodeRefForNodeId: (state: object, nodeId: string, fallback: string) =>
    epicNodeRefForNodeId(state, nodeId, fallback),
}));

// The chip imports the canvas store and `@dnd-kit/core` at its module top, so
// these spies must exist before those (hoisted) `vi.mock` factories run.
// `vi.hoisted` guarantees that ordering; `resolveTabIdForEpic` is the pure,
// non-side-effecting resolver the chip reads for its `viewTabId` (constraint
// C1), returning a tab id for the open epic and `null` otherwise.
const {
  openTilePreviewInEpic,
  openTilePreviewInTab,
  resolveTargetTabForEpic,
  resolveTabIdForEpic,
  useDraggableSpy,
  setNodeRefSpy,
} = vi.hoisted(() => ({
  openTilePreviewInEpic: vi.fn(),
  openTilePreviewInTab: vi.fn(),
  resolveTargetTabForEpic: vi.fn(() => "tab-for-open-epic"),
  resolveTabIdForEpic: vi.fn((epicId: string) =>
    epicId === "epic-open" ? "tab-for-open-epic" : null,
  ),
  // Capture every `useDraggable` call so tests can assert the emitted payload
  // and the `disabled` gate without wiring a DndContext + pointer simulation.
  // Only a drag-eligible (same-epic spec/ticket) chip mounts the draggable
  // child, so a non-eligible chip leaves this spy uncalled.
  useDraggableSpy:
    vi.fn<(args: { id: string; disabled: boolean; data: unknown }) => void>(),
  // Captures the node the chip hands to dnd-kit's `setNodeRef`, so a test can
  // assert the drag surface is actually attached to the rendered button (not
  // just that `useDraggable` was called with the right input).
  setNodeRefSpy: vi.fn<(element: HTMLElement | null) => void>(),
}));

// `useEpicCanvasStore` is used as a selector hook by the chip's drag source, so
// the mock is a callable with `getState` for compatibility with callers that
// still read the store imperatively.
vi.mock("@/stores/epics/canvas/store", () => {
  const canvasState = {
    resolveTargetTabForEpic,
    openTilePreviewInTab,
  };
  return {
    useEpicCanvasStore: Object.assign(
      (selector: (state: typeof canvasState) => unknown) =>
        selector(canvasState),
      { getState: () => canvasState },
    ),
    // Standalone pure resolver: the shared `useArtifactDragSource` hook
    // reads `viewTabId` via `resolveTabIdForEpic(state, epicId)`. Delegate to the
    // same spy by `epicId` so the existing single-arg call assertion holds.
    resolveTabIdForEpic: (_state: typeof canvasState, epicId: string) =>
      resolveTabIdForEpic(epicId),
  };
});

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTilePreviewInEpic,
    openTilePreviewInTab: vi.fn(),
    openTileInTab: vi.fn(),
    openTileInEpic: vi.fn(),
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (args: { id: string; disabled: boolean; data: unknown }) => {
    useDraggableSpy(args);
    return {
      // A marker attribute the chip spreads onto its button - lets a test assert
      // the drag surface is wired to the DOM (a broken `ref`/spread would drop
      // it) rather than only asserting the `useDraggable` input.
      attributes: { "data-dnd-attached": "true" },
      listeners: {},
      setNodeRef: setNodeRefSpy,
      isDragging: false,
    };
  },
}));

function lastDraggableCall(): {
  id: string;
  disabled: boolean;
  data: unknown;
} {
  const calls = useDraggableSpy.mock.calls;
  return calls[calls.length - 1][0];
}

const navigateToTabIntent = vi.fn();
const openOrFocusEpicIntent = vi.fn(
  (input: { epicId: string; focus: unknown }) => ({ kind: "epic", ...input }),
);

vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (...args: unknown[]) => {
    navigateToTabIntent(...args);
  },
  openOrFocusEpicIntent: (input: { epicId: string; focus: unknown }) =>
    openOrFocusEpicIntent(input),
}));

// `vi.mock` factories are hoisted above these imports, so the components and
// `TraycerMarkdown` bind to the mocked modules.
import { TraycerMarkdown } from "@/markdown/traycer-markdown";
import { TraycerSpecReference } from "@/markdown/components/traycer-spec-reference";
import { TraycerTicketReference } from "@/markdown/components/traycer-ticket-reference";
import { TraycerChatReference } from "@/markdown/components/traycer-chat-reference";
import { TraycerEpicReference } from "@/markdown/components/traycer-epic-reference";

beforeEach(() => {
  mockHandle = { epicId: OPEN_EPIC_ID, store: { getState: () => ({}) } };
  mockActiveHostId = "active-host-1";
  navigate.mockClear();
  epicNodeRefForNodeId.mockClear();
  openTilePreviewInEpic.mockClear();
  openTilePreviewInTab.mockClear();
  resolveTargetTabForEpic.mockClear();
  resolveTabIdForEpic.mockClear();
  navigateToTabIntent.mockClear();
  openOrFocusEpicIntent.mockClear();
  useDraggableSpy.mockClear();
  setNodeRefSpy.mockClear();
});

afterEach(cleanup);

function clickRef(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("legacy traycer-* reference components", () => {
  it("same-epic spec opens the artifact tile as a preview", () => {
    render(
      <TraycerSpecReference
        data-epic-id={OPEN_EPIC_ID}
        data-spec-id="spec-1"
        data-title="Spec One"
      >
        Spec One
      </TraycerSpecReference>,
    );

    clickRef("Spec One");

    expect(resolveTargetTabForEpic).not.toHaveBeenCalled();
    expect(openTilePreviewInEpic).toHaveBeenCalledWith(OPEN_EPIC_ID, {
      id: "spec-1",
      instanceId: "inst-spec",
      type: "spec",
      name: "Spec One",
      hostId: "active-host-1",
    });
    expect(navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("same-epic chat opens a chat tile as a preview", () => {
    render(
      <TraycerChatReference data-epic-id={OPEN_EPIC_ID} data-chat-id="chat-1">
        Chat One
      </TraycerChatReference>,
    );

    clickRef("Chat One");

    expect(openTilePreviewInEpic).toHaveBeenCalledWith(OPEN_EPIC_ID, {
      id: "chat-1",
      instanceId: "inst-chat",
      type: "chat",
      name: "Chat One",
      hostId: "active-host-1",
    });
    expect(navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("cross-epic ticket navigates with focusArtifactId", () => {
    render(
      <TraycerTicketReference
        data-epic-id="epic-other"
        data-ticket-id="ticket-9"
      >
        Ticket Nine
      </TraycerTicketReference>,
    );

    clickRef("Ticket Nine");

    expect(openTilePreviewInEpic).not.toHaveBeenCalled();
    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(openOrFocusEpicIntent).toHaveBeenCalledTimes(1);
    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-other");
    expect(arg.focus).toMatchObject({
      focusArtifactId: "ticket-9",
      focusThreadId: undefined,
      migrationSource: undefined,
    });
    expect(typeof (arg.focus as { focusedAt: unknown }).focusedAt).toBe(
      "number",
    );
  });

  it("cross-epic chat reuses focusArtifactId (no focusChatId)", () => {
    render(
      <TraycerChatReference data-epic-id="epic-other" data-chat-id="chat-42">
        Chat Forty-Two
      </TraycerChatReference>,
    );

    clickRef("Chat Forty-Two");

    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-other");
    expect(arg.focus).toMatchObject({ focusArtifactId: "chat-42" });
    expect(arg.focus).not.toHaveProperty("focusChatId");
  });

  it("traycer-epic focuses the epic with no artifact id", () => {
    render(
      <TraycerEpicReference data-epic-id="epic-other">
        Some Epic
      </TraycerEpicReference>,
    );

    clickRef("Some Epic");

    expect(openTilePreviewInEpic).not.toHaveBeenCalled();
    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-other");
    expect(arg.focus).toMatchObject({ focusArtifactId: undefined });
  });

  it("renders plain text when the embedded id is missing", () => {
    render(
      <TraycerSpecReference data-epic-id={OPEN_EPIC_ID}>
        Bare
      </TraycerSpecReference>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Bare")).toBeTruthy();
  });

  it("renders plain text when the epic id is missing", () => {
    render(
      <TraycerChatReference data-chat-id="chat-1">
        No Epic
      </TraycerChatReference>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("No Epic")).toBeTruthy();
  });

  it("renders plain text when there is no open-epic session context", () => {
    mockHandle = null;
    render(
      <TraycerSpecReference data-epic-id={OPEN_EPIC_ID} data-spec-id="spec-1">
        Detached Spec
      </TraycerSpecReference>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Detached Spec")).toBeTruthy();
  });

  it("renders plain text when a same-epic node does not resolve", () => {
    render(
      <TraycerSpecReference
        data-epic-id={OPEN_EPIC_ID}
        data-spec-id="spec-missing"
      >
        Missing Spec
      </TraycerSpecReference>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Missing Spec")).toBeTruthy();
  });
});

// ─── Inline-chip drag source (T3) ────────────────────────────────────────────

describe("same-epic spec/ticket chips are canvas drag sources", () => {
  it("a same-epic spec chip registers a draggable, emits the payload, and wires the drag surface", () => {
    render(
      <TraycerSpecReference
        data-epic-id={OPEN_EPIC_ID}
        data-spec-id="spec-1"
        data-title="Spec One"
      >
        Spec One
      </TraycerSpecReference>,
    );

    // Only the eligible chip mounts the draggable child and registers a source.
    expect(useDraggableSpy).toHaveBeenCalledTimes(1);
    const call = lastDraggableCall();
    expect(call.disabled).toBe(false);
    // Occurrence-unique drag id keyed on `useId()` (C3), not the artifact id.
    expect(call.id.startsWith("chat-artifact:")).toBe(true);
    expect(call.id).not.toBe("chat-artifact:spec-1");
    expect(resolveTabIdForEpic).toHaveBeenCalledWith(OPEN_EPIC_ID);
    expect(call.data).toEqual({
      kind: "chat-artifact",
      epicId: OPEN_EPIC_ID,
      viewTabId: "tab-for-open-epic",
      artifact: {
        id: "spec-1",
        type: "spec",
        name: "Spec One",
        hostId: "active-host-1",
      },
    });
    // The drag surface is actually attached to the rendered button (ref +
    // attributes), not merely requested from `useDraggable`.
    const button = screen.getByRole("button", { name: "Spec One" });
    expect(button.getAttribute("data-dnd-attached")).toBe("true");
    expect(setNodeRefSpy).toHaveBeenCalled();
    expect(
      setNodeRefSpy.mock.calls.some(
        ([element]) => element instanceof HTMLElement,
      ),
    ).toBe(true);
    // Drag is purely additive - the pill still opens on click.
    clickRef("Spec One");
    expect(openTilePreviewInEpic).toHaveBeenCalledTimes(1);
  });

  it("a same-epic ticket chip registers a draggable, emits the payload, and wires the drag surface", () => {
    render(
      <TraycerTicketReference
        data-epic-id={OPEN_EPIC_ID}
        data-ticket-id="ticket-1"
      >
        Ticket One
      </TraycerTicketReference>,
    );

    expect(useDraggableSpy).toHaveBeenCalledTimes(1);
    const call = lastDraggableCall();
    expect(call.disabled).toBe(false);
    expect(call.data).toEqual({
      kind: "chat-artifact",
      epicId: OPEN_EPIC_ID,
      viewTabId: "tab-for-open-epic",
      artifact: {
        id: "ticket-1",
        type: "ticket",
        name: "Ticket One",
        hostId: "active-host-1",
      },
    });
    const button = screen.getByRole("button", { name: "Ticket One" });
    expect(button.getAttribute("data-dnd-attached")).toBe("true");
    expect(setNodeRefSpy).toHaveBeenCalled();
  });

  it("a cross-epic (navigate) ticket chip registers no draggable but still clicks", () => {
    render(
      <TraycerTicketReference
        data-epic-id="epic-other"
        data-ticket-id="ticket-9"
      >
        Ticket Nine
      </TraycerTicketReference>,
    );

    // A click-only chip never touches the canvas store or dnd-kit.
    expect(useDraggableSpy).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Ticket Nine" });
    expect(button.getAttribute("data-dnd-attached")).toBeNull();
    // Click semantics are unchanged - it still navigates.
    clickRef("Ticket Nine");
    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(openTilePreviewInEpic).not.toHaveBeenCalled();
  });

  it("an inert (none) reference registers no draggable and stays plain text", () => {
    render(
      <TraycerSpecReference
        data-epic-id={OPEN_EPIC_ID}
        data-spec-id="spec-missing"
      >
        Missing Spec
      </TraycerSpecReference>,
    );

    expect(useDraggableSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Missing Spec")).toBeTruthy();
  });

  it("a same-epic chat chip registers no draggable (chat is out of scope)", () => {
    render(
      <TraycerChatReference data-epic-id={OPEN_EPIC_ID} data-chat-id="chat-1">
        Chat One
      </TraycerChatReference>,
    );

    expect(useDraggableSpy).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Chat One" });
    expect(button.getAttribute("data-dnd-attached")).toBeNull();
    // Click still opens the same-epic chat tile.
    clickRef("Chat One");
    expect(openTilePreviewInEpic).toHaveBeenCalledTimes(1);
  });

  it("an epic reference registers no draggable (navigate-only)", () => {
    render(
      <TraycerEpicReference data-epic-id="epic-other">
        Some Epic
      </TraycerEpicReference>,
    );

    expect(useDraggableSpy).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Some Epic" });
    expect(button.getAttribute("data-dnd-attached")).toBeNull();
  });
});

// ─── DEFAULT_COMPONENTS wiring smoke test ────────────────────────────────────

function renderMarkdown(markdown: string) {
  return render(
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming={false}
    >
      {markdown}
    </TraycerMarkdown>,
  );
}

describe("DEFAULT_COMPONENTS wires the legacy reference tags", () => {
  it("renders a clickable chip for a same-epic <traycer-spec> tag", () => {
    renderMarkdown(
      `<traycer-spec epicId="${OPEN_EPIC_ID}" specId="spec-1" title="Spec One">Spec One</traycer-spec>`,
    );

    clickRef("Spec One");

    expect(openTilePreviewInEpic).toHaveBeenCalledWith(
      OPEN_EPIC_ID,
      expect.objectContaining({ id: "spec-1", type: "spec" }),
    );
  });
});
