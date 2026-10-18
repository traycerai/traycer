import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

// The overlay, the text toolbar and the annotation action run for real. What
// is mocked is what lies outside them: which chats exist and which is open,
// revealing a chat, the host's copy of the source, the window's screenshot
// bridge, and the composer draft the record is finally attached to.

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);
vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => null,
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
    ChatTargetMenu: (props: { readonly trigger: ReactNode }) => props.trigger,
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
  // The overlay measures the frame it sits over.
  const frame = document.createElement("iframe");
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
        boardPath={BOARD_PATH}
        registry={registry}
        onPick={() => undefined}
        onRetire={() => undefined}
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

describe("a selected range beside its formatting", () => {
  it("offers formatting and Add to chat together for a range of source text", async () => {
    mountOverlay();
    select(LITERAL);
    expect(
      await screen.findByRole("toolbar", { name: "Text formatting" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeDefined();
  });

  it("offers Add to chat, and no formatting, for a range the page generated", async () => {
    mountOverlay();
    select(GENERATED);
    expect(
      await screen.findByRole("button", { name: "Add to chat" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("toolbar", { name: "Text formatting" }),
    ).toBeNull();
  });

  it("still formats from the toolbar next to the action", async () => {
    mountOverlay();
    select(LITERAL);
    const bold = await screen.findByRole("button", { name: "Bold" });
    await vi.waitFor(() => expect(bold).toHaveProperty("disabled", false));
    fireEvent.click(bold);

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "wrap-text-range",
      tag: "b",
      start: 6,
      end: 9,
      href: null,
      expectedText: "big",
    });
  });
});

describe("attaching a selected range to a chat", () => {
  async function addToChat(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
  }
  function attachedRecord(): CanvasAnnotationRecord {
    expect(outside.attach).toHaveBeenCalledOnce();
    return outside.attach.mock.calls[0][0].record;
  }

  it("attaches a record carrying the range, its quote and where it sits in the source", async () => {
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Add to chat" });
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

  it("reveals the chat it attached to", async () => {
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Add to chat" });
    await addToChat();
    expect(outside.reveal).toHaveBeenCalledWith("chat-1");
  });

  it("waits for the source of a range in source text rather than attaching a guess", async () => {
    outside.source.current = null;
    mountOverlay();
    select(LITERAL);
    await screen.findByRole("button", { name: "Add to chat" });
    await addToChat();

    expect(outside.attach).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The artboard source is still loading. Try again.",
    );
  });

  it("attaches a generated range without a tid or a source position, and without the source", async () => {
    outside.source.current = null;
    mountOverlay();
    select(GENERATED);
    await screen.findByRole("button", { name: "Add to chat" });
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
    await screen.findByRole("button", { name: "Add to chat" });
    await addToChat();
    expect(attachedRecord().elements[0]).toMatchObject({
      textRange: { quote: "BIG" },
    });
  });

  it("keeps the action when the formatting toolbar is refused for a mismatched quote", async () => {
    mountOverlay();
    select(
      quotedSelection("Hello BIG world", 6, 9, {
        tid: "t",
        tagName: "p",
        marker: 0,
      }),
    );
    expect(await screen.findByText(/changed by a script/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeDefined();
  });
});
