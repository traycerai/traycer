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

const openTilePreviewInTab = vi.fn();
const resolveTargetTabForEpic = vi.fn(() => "tab-for-open-epic");

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => ({
      resolveTargetTabForEpic,
      openTilePreviewInTab,
    }),
  },
}));

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
  openTilePreviewInTab.mockClear();
  resolveTargetTabForEpic.mockClear();
  navigateToTabIntent.mockClear();
  openOrFocusEpicIntent.mockClear();
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

    expect(resolveTargetTabForEpic).toHaveBeenCalledWith(
      OPEN_EPIC_ID,
      undefined,
    );
    expect(openTilePreviewInTab).toHaveBeenCalledWith("tab-for-open-epic", {
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

    expect(openTilePreviewInTab).toHaveBeenCalledWith("tab-for-open-epic", {
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

    expect(openTilePreviewInTab).not.toHaveBeenCalled();
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

    expect(openTilePreviewInTab).not.toHaveBeenCalled();
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

// ─── DEFAULT_COMPONENTS wiring smoke test ────────────────────────────────────

function renderMarkdown(markdown: string) {
  return render(
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
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

    expect(openTilePreviewInTab).toHaveBeenCalledWith(
      "tab-for-open-epic",
      expect.objectContaining({ id: "spec-1", type: "spec" }),
    );
  });
});
