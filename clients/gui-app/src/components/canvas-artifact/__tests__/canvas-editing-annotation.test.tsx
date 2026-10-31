import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { QuoteChatTarget } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import type { ArtifactReadSpan } from "@/lib/sandbox/artifact-serving";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useNewConversationAnnotationStore } from "@/stores/epics/new-conversation-annotation-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import { CanvasEditingOverlay } from "../canvas-editing-overlay";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import {
  BOARD_PATH,
  disposeBridges,
  pendingSaves,
  canvasElement,
  quotedSelection,
  realBridge,
  registryServing,
} from "./canvas-edit-test-support";

// The overlay and the annotation action run for real. What is mocked is what lies outside them: which chats exist and which is open,
// revealing a chat, the host's copy of the source, the window's screenshot
// bridge, and the composer draft the record is finally attached to.

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);
vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => null,
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => false,
}));

interface AttachInput {
  readonly chatId: string;
  readonly record: CanvasAnnotationRecord;
  readonly crop: Uint8Array | null;
}
interface Outside {
  readonly attach: Mock<
    (input: AttachInput) => Promise<CanvasAnnotationRecord>
  >;
  readonly reveal: Mock<(chatId: string) => void>;
  readonly source: { current: { kind: "text"; text: string } | null };
  /** The desktop's window screenshot bridge, or `null` where there is none (web). */
  readonly capture: {
    current: {
      captureRegion: Mock<(rect: CanvasBox) => Promise<ArrayBuffer | null>>;
    } | null;
  };
  /**
   * The mocked roster's exit animation. With `hold` set, a closed menu stays
   * mounted and `onClosed` waits until `release` is called, the way Radix
   * keeps the content until its exit animation ends.
   */
  readonly menuExit: { hold: boolean; release: (() => void) | null };
}
const outside = vi.hoisted((): Outside => ({
  attach: vi.fn(),
  reveal: vi.fn(),
  source: { current: null },
  capture: { current: null },
  menuExit: { hold: false, release: null },
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({ store: createStore(() => ({ chats: {} })) }),
}));
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => ["chat-1"],
}));
vi.mock("@/components/epic-canvas/renderers/use-reveal-chat-in-tab", () => ({
  useRevealChatInTab: () => outside.reveal,
}));
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/epics/canvas/store")>()),
  useOpenTileContentIds: () => new Set<string>(),
}));
vi.mock(
  "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets")
    >()),
    resolveQuoteChatTargets: (): QuoteChatTarget[] => [
      {
        chatId: "chat-1",
        title: "Chat one",
        isOpen: true,
        isLastFocused: true,
        isOnOtherHost: false,
      },
    ],
  }),
);
vi.mock(
  "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu",
  async () => {
    const { useEffect, useRef, useState } = await import("react");
    // The roster is Radix's; what matters here is that it lists the chats only
    // once the trigger has opened it, and that it reports the menu gone the
    // way Radix does: from the unmount that follows a close, not from the
    // close itself. With `outside.menuExit.hold` the closed menu stays on
    // screen until the test releases it, standing in for the exit animation.
    function ChatTargetMenu(props: {
      readonly trigger: ReactNode;
      readonly targets: readonly QuoteChatTarget[];
      readonly open: boolean;
      readonly onOpenChange: (open: boolean) => void;
      readonly onClosed: (() => void) | null;
      readonly onSelectChat: (chatId: string) => void;
      readonly onSelectNewChat: (() => void) | null;
    }) {
      const wasOpen = useRef(false);
      const [exiting, setExiting] = useState(false);
      const { open, onClosed } = props;
      useEffect(() => {
        if (wasOpen.current && !open) {
          if (outside.menuExit.hold) {
            setExiting(true);
            outside.menuExit.release = () => {
              setExiting(false);
              if (onClosed !== null) onClosed();
            };
          } else if (onClosed !== null) onClosed();
        }
        wasOpen.current = open;
      }, [open, onClosed]);
      return (
        <div>
          <div
            role="presentation"
            onClick={() => props.onOpenChange(!props.open)}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onOpenChange(!props.open);
            }}
          >
            {props.trigger}
          </div>
          {props.open || exiting ? (
            <div role="menu">
              {props.targets.map((target) => (
                <button
                  key={target.chatId}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    // Radix closes the menu on a pick before the item's own
                    // handler runs; the real roster does the same.
                    props.onOpenChange(false);
                    props.onSelectChat(target.chatId);
                  }}
                >
                  {target.title}
                </button>
              ))}
              {props.onSelectNewChat === null ? null : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onOpenChange(false);
                    props.onSelectNewChat?.();
                  }}
                >
                  New chat
                </button>
              )}
            </div>
          ) : null}
        </div>
      );
    }
    return { ChatTargetMenu };
  },
);
vi.mock("@/hooks/files/use-artifact-object-text-query", () => ({
  useArtifactObjectTextQuery: () => ({ data: outside.source.current }),
}));
vi.mock("../canvas-annotation-attach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../canvas-annotation-attach")>()),
  canvasWindowCaptureBridge: () => outside.capture.current,
  attachCanvasAnnotation: outside.attach,
}));

const SHA = "sha-served";
const HTML = `<p data-tid="t">Hello big world</p>`;
const BYTES = new TextEncoder().encode(HTML);
const SCOPE = {
  epicId: "epic-1",
  artifactId: "canvas-1",
  artifactTitle: "Wiring",
  artifactType: "canvas" as const,
  hostId: "host-1",
  viewTabId: "tab-1",
};

const readSpan: ArtifactReadSpan = (_hash, offset, length, signal) => {
  signal.throwIfAborted();
  return Promise.resolve({
    bytes: BYTES.slice(offset, offset + length),
    totalBytes: BYTES.length,
    mediaType: "text/html",
  });
};

/** The stage the action bar portals into: the pane the frame sits in. */
let stage: HTMLElement | null = null;

function mountOverlay() {
  const bridge = realBridge();
  vi.spyOn(bridge, "elementBox").mockResolvedValue({
    x: 40,
    y: 100,
    width: 200,
    height: 24,
  });
  vi.spyOn(bridge, "describeElement").mockResolvedValue(null);
  // An element with neither a tid nor a marker (one a script generated) is
  // found again by what is at its centre, so the page must answer that with
  // the element that is selected.
  vi.spyOn(bridge, "hitTest").mockImplementation(() =>
    Promise.resolve(
      useCanvasSelectionStore.getState().selection?.element ?? null,
    ),
  );
  const registry = registryServing(bridge, SHA);
  // The overlay measures the frame it sits over, and the action bar portals
  // into the pane around it, so the frame must live in one.
  stage = document.createElement("div");
  stage.className = "react-flow";
  document.body.append(stage);
  const frame = document.createElement("iframe");
  stage.append(frame);
  Object.defineProperty(frame, "clientWidth", { value: 640 });
  Object.defineProperty(frame, "clientHeight", { value: 360 });
  // jsdom lays nothing out; the capture rect is the frame's box on screen.
  frame.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
  registry.update(BOARD_PATH, {
    frame,
    source: {
      kind: "artifact",
      canvas: true,
      artifactId: SCOPE.artifactId,
      treePath: "wiring",
      entryPath: BOARD_PATH,
      manifest: {
        files: {
          [BOARD_PATH]: {
            sha256: SHA,
            byteLength: BYTES.length,
            mediaType: "text/html",
          },
        },
      },
      readSpan,
      resolveOutsideReference: () => null,
    },
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CanvasEditingOverlay
        scope={SCOPE}
        tileId="canvas-tile-1"
        boardPath={BOARD_PATH}
        registry={registry}
        onPick={() => undefined}
        onRetire={() => undefined}
        onEscape={() => undefined}
      />
    </QueryClientProvider>,
  );
  return bridge;
}

function select(selection: CanvasSelection): void {
  act(() => {
    useCanvasSelectionStore.getState().select(selection);
  });
}

beforeEach(() => {
  pendingSaves.length = 0;
  outside.attach
    .mockReset()
    .mockImplementation((input) => Promise.resolve(input.record));
  outside.reveal.mockReset();
  outside.source.current = { kind: "text", text: HTML };
  outside.capture.current = null;
  outside.menuExit.hold = false;
  outside.menuExit.release = null;
  useCanvasSelectionStore.getState().clear();
  resetNegotiatedManifests();
  useNewConversationAnnotationStore.setState({ byEpicId: {} });
  useNewConversationModalOpenStore.setState({ request: null });
});

afterEach(() => {
  cleanup();
  stage?.remove();
  stage = null;
  disposeBridges();
  vi.restoreAllMocks();
  useCanvasSelectionStore.getState().clear();
});

const LITERAL = quotedSelection("Hello big world", 6, 9, {
  tid: "t",
  tagName: "p",
  marker: 0,
});
const GENERATED = quotedSelection("Hello big world", 6, 9, {
  generated: true,
  marker: null,
  tid: null,
  tagName: "b",
});

describe("a selected range's action bar", () => {
  const formatting = (): HTMLElement | null =>
    screen.queryByRole("toolbar", { name: "Text formatting" });
  const chatOne = (): HTMLElement | null =>
    screen.queryByRole("menuitem", { name: "Chat one" });

  it("offers Send to chat for a range of source text, with no formatting controls", async () => {
    mountOverlay();
    select(LITERAL);
    expect(
      await screen.findByRole("button", { name: "Send to chat" }),
    ).toBeDefined();
    expect(formatting()).toBeNull();
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
  });

  it("offers Send to chat, and no formatting, for a range the page generated", async () => {
    mountOverlay();
    select(GENERATED);
    expect(
      await screen.findByRole("button", { name: "Send to chat" }),
    ).toBeDefined();
    expect(formatting()).toBeNull();
  });

  it("sits in the pane around the frame", async () => {
    mountOverlay();
    select(LITERAL);
    const button = await screen.findByRole("button", { name: "Send to chat" });
    expect(stage?.contains(button)).toBe(true);
  });

  it("lists the chats only in the popover that Send to chat opens", async () => {
    mountOverlay();
    select(LITERAL);
    const button = await screen.findByRole("button", { name: "Send to chat" });
    expect(chatOne()).toBeNull();

    fireEvent.click(button);
    expect(chatOne()).not.toBeNull();

    fireEvent.click(button);
    expect(chatOne()).toBeNull();
  });

  it("attaches nothing until a chat is chosen from the popover", async () => {
    mountOverlay();
    select(LITERAL);
    const button = await screen.findByRole("button", { name: "Send to chat" });
    // An attach started by opening would run through the mutation's promise
    // chain, so the click is awaited inside act to flush that interaction's work.
    // The opened roster is the phase observed; this does not bound later
    // scheduled work.
    await act(() => {
      fireEvent.click(button);
      return Promise.resolve();
    });
    expect(
      await screen.findByRole("menuitem", { name: "Chat one" }),
    ).toBeDefined();

    expect(outside.attach).not.toHaveBeenCalled();
  });
});

describe("attaching a selected range to a chat", () => {
  function chooseChatOne(): void {
    fireEvent.click(screen.getByRole("button", { name: "Send to chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat one" }));
  }
  // A successful attach ends in onSuccess, which reveals the chat and closes
  // the popover; wait for that outcome, not for elapsed time.
  async function addToChat(): Promise<void> {
    chooseChatOne();
    await waitFor(() => {
      expect(outside.reveal).toHaveBeenCalledWith("chat-1");
      expect(screen.queryByRole("menuitem", { name: "Chat one" })).toBeNull();
    });
  }
  function attachedRecord(): CanvasAnnotationRecord {
    expect(outside.attach).toHaveBeenCalledOnce();
    return outside.attach.mock.calls[0][0].record;
  }

  it("attaches a record carrying the range, its quote and where it sits in the source", async () => {
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    await addToChat();

    expect(outside.attach.mock.calls[0][0]).toMatchObject({
      chatId: "chat-1",
      crop: null,
    });
    const record = attachedRecord();
    expect(record).toMatchObject({
      kind: "browser-annotation",
      source: {
        kind: "canvas",
        artifactId: SCOPE.artifactId,
        artifactTitle: SCOPE.artifactTitle,
        boardPath: BOARD_PATH,
        canvasPage: null,
      },
      counts: { elements: 1, regions: 0, strokes: 0 },
    });
    expect(record.elements).toHaveLength(1);
    expect(record.elements[0]).toMatchObject({
      tagName: "p",
      tid: "t",
      textRange: { start: 6, end: 9, quote: "big" },
      sourceRange: { start: 0, end: HTML.length, line: 1 },
    });
  });

  it("reveals the chat it attached to and closes the popover", async () => {
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    await addToChat();
    expect(outside.reveal).toHaveBeenCalledWith("chat-1");
    expect(screen.queryByRole("menuitem", { name: "Chat one" })).toBeNull();
  });

  it("screenshots the window only once the picker is gone and the selection chrome is hidden", async () => {
    // What the window looked like at the instant it was photographed. The
    // crop is cut from the app window as composited, so a picker still
    // fading out or the outline around the element would be in the picture.
    const seen = {
      menu: true,
      outline: true,
      actionBarVisible: true,
    };
    const png = new Uint8Array([137, 80, 78, 71]);
    outside.capture.current = {
      captureRegion: vi.fn(() => {
        seen.menu = screen.queryByRole("menu") !== null;
        seen.outline =
          document.querySelector("[data-canvas-selection-outline]") !== null;
        seen.actionBarVisible =
          document
            .querySelector("[data-canvas-selection-action]")
            ?.classList.contains("invisible") === false;
        return Promise.resolve(png.buffer.slice(0));
      }),
    };
    // The picker keeps painting through its exit animation after the pick;
    // nothing may be photographed until it reports itself gone.
    outside.menuExit.hold = true;
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    expect(
      document.querySelector("[data-canvas-selection-outline]"),
    ).not.toBeNull();
    chooseChatOne();
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(outside.capture.current.captureRegion).not.toHaveBeenCalled();
    act(() => outside.menuExit.release?.());
    await waitFor(() => {
      expect(outside.reveal).toHaveBeenCalledWith("chat-1");
      expect(screen.queryByRole("menuitem", { name: "Chat one" })).toBeNull();
    });

    expect(outside.capture.current.captureRegion).toHaveBeenCalledOnce();
    expect(seen).toEqual({
      menu: false,
      outline: false,
      actionBarVisible: false,
    });
    expect(outside.attach.mock.calls[0][0].crop).toEqual(png);
    // The chrome is back once the picture is taken: the selection is still
    // the user's, and the action bar is where the next send starts.
    expect(
      document.querySelector("[data-canvas-selection-outline]"),
    ).not.toBeNull();
    expect(
      document
        .querySelector("[data-canvas-selection-action]")
        ?.classList.contains("invisible"),
    ).toBe(false);
  });

  it("does not wait on animation frames the window will never paint while hidden", async () => {
    // A hidden window stops requestAnimationFrame entirely (background
    // throttling), so a capture that waited for a frame would hang with the
    // chrome hidden until the window came back.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    outside.capture.current = {
      captureRegion: vi.fn(() => Promise.resolve(new Uint8Array([1]).buffer)),
    };
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    await addToChat();

    expect(outside.capture.current.captureRegion).toHaveBeenCalledOnce();
    expect(useCanvasSelectionStore.getState().capturing).toBe(false);
  });

  it("waits for the source of a range in source text rather than attaching a guess", async () => {
    outside.source.current = null;
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    chooseChatOne();

    // The refusal never reveals or closes the popover; its completion is the alert.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The artboard source is still loading. Try again.",
    );
    expect(outside.attach).not.toHaveBeenCalled();
  });

  it("attaches a generated range without a tid or a source position, and without the source", async () => {
    outside.source.current = null;
    mountOverlay();
    select(GENERATED);
    await screen.findByRole("button", { name: "Send to chat" });
    await addToChat();

    const record = attachedRecord();
    expect(record.elements[0]).toMatchObject({
      tagName: "b",
      tid: null,
      sourceRange: null,
      textRange: { start: 6, end: 9, quote: "big" },
    });
  });

  it("attaches the quote the page reported, not one rebuilt from the source", async () => {
    mountOverlay();
    // The page selected "BIG" (a script upper-cased it); the source says "big".
    select(
      quotedSelection("Hello BIG world", 6, 9, {
        tid: "t",
        tagName: "p",
        marker: 0,
      }),
    );
    await screen.findByRole("button", { name: "Send to chat" });
    await addToChat();
    expect(attachedRecord().elements[0]).toMatchObject({
      textRange: { quote: "BIG" },
    });
  });
});

describe("the selection bar and its keyboard", () => {
  const shield = (): HTMLElement => {
    const overlay = document.querySelector("[data-canvas-selection-overlay]");
    const element = overlay?.firstElementChild;
    if (!(element instanceof HTMLElement)) throw new Error("no shield");
    return element;
  };
  const SECTION = canvasElement({
    tid: "section",
    tagName: "section",
    selector: "section",
    marker: 3,
  });

  it("offers Send to chat with no Element actions menu beside it", async () => {
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });
    expect(
      screen.queryByRole("button", { name: "Element actions" }),
    ).toBeNull();
  });

  it("selects the literal ancestor on Shift+Enter and ignores a plain Enter", async () => {
    const bridge = mountOverlay();
    const literalAncestor = vi
      .spyOn(bridge, "literalAncestor")
      .mockResolvedValue(SECTION);
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });

    fireEvent.keyDown(shield(), { key: "Enter" });
    expect(literalAncestor).not.toHaveBeenCalled();

    fireEvent.keyDown(shield(), { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(useCanvasSelectionStore.getState().selection?.element.tid).toBe(
        "section",
      );
    });
    expect(literalAncestor).toHaveBeenCalledOnce();
    expect(useCanvasSelectionStore.getState().selection?.textRange).toBeNull();
  });

  it("clears the selection when the ancestor is the page body", async () => {
    const bridge = mountOverlay();
    vi.spyOn(bridge, "literalAncestor").mockResolvedValue(
      canvasElement({ tagName: "body", selector: "body", tid: null }),
    );
    select(LITERAL);
    await screen.findByRole("button", { name: "Send to chat" });

    fireEvent.keyDown(shield(), { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(useCanvasSelectionStore.getState().selection).toBeNull();
    });
  });
});

describe("sending a selected range to a new chat", () => {
  const newChat = (): HTMLElement | null =>
    screen.queryByRole("menuitem", { name: "New chat" });

  async function openPicker(): Promise<void> {
    mountOverlay();
    select(LITERAL);
    fireEvent.click(
      await screen.findByRole("button", { name: "Send to chat" }),
    );
  }

  it("puts the card in the new-conversation sidecar and opens the modal once the host takes it", async () => {
    recordNegotiatedHostManifest(SCOPE.hostId, {
      "epic.createChat": { major: 1, minor: 5 },
    });
    await openPicker();

    fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));

    await waitFor(() => {
      expect(useNewConversationModalOpenStore.getState().request).toEqual({
        epicId: SCOPE.epicId,
        tabId: SCOPE.viewTabId,
        placement: null,
        parentId: null,
        hostId: null,
      });
    });
    const cards =
      useNewConversationAnnotationStore.getState().byEpicId[SCOPE.epicId] ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0].elements[0]).toMatchObject({
      tid: "t",
      textRange: { quote: "big" },
    });
    expect(outside.attach).not.toHaveBeenCalled();
  });

  it.each([
    ["a host below the minor", { major: 1, minor: 4 }],
    ["a host that has not negotiated", null],
  ])("offers no New chat for %s", async (_name, version) => {
    if (version !== null)
      recordNegotiatedHostManifest(SCOPE.hostId, {
        "epic.createChat": version,
      });
    await openPicker();

    expect(screen.getByRole("menuitem", { name: "Chat one" })).toBeDefined();
    expect(newChat()).toBeNull();
  });
});
