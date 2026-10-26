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
import { CanvasEditingOverlay } from "../canvas-editing-overlay";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import {
  BOARD_PATH,
  disposeBridges,
  pendingSaves,
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
}
const outside = vi.hoisted((): Outside => ({
  attach: vi.fn(),
  reveal: vi.fn(),
  source: { current: null },
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
  () => ({
    // The roster is Radix's; what matters here is that it lists the chats only
    // once the trigger has opened it.
    ChatTargetMenu: (props: {
      readonly trigger: ReactNode;
      readonly targets: readonly QuoteChatTarget[];
      readonly open: boolean;
      readonly onOpenChange: (open: boolean) => void;
      readonly onSelectChat: (chatId: string) => void;
    }) => (
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
        {props.open ? (
          <div role="menu">
            {props.targets.map((target) => (
              <button
                key={target.chatId}
                type="button"
                role="menuitem"
                onClick={() => props.onSelectChat(target.chatId)}
              >
                {target.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ),
  }),
);
vi.mock("@/hooks/files/use-artifact-object-text-query", () => ({
  useArtifactObjectTextQuery: () => ({ data: outside.source.current }),
}));
vi.mock("../canvas-annotation-attach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../canvas-annotation-attach")>()),
  canvasWindowCaptureBridge: () => null,
  attachCanvasAnnotation: outside.attach,
}));

const SHA = "sha-served";
const HTML = `<p data-tid="t">Hello big world</p>`;
const BYTES = new TextEncoder().encode(HTML);
const SCOPE = {
  epicId: "epic-1",
  artifactId: "canvas-1",
  artifactTitle: "Wiring",
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
  useCanvasSelectionStore.getState().clear();
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
