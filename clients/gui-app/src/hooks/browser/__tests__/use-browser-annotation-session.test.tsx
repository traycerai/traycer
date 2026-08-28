import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import type { AnnotationRoute } from "@/lib/browser-view/annotation/browser-annotation-router";
import type { BrowserAnnotationAttachedIpcEvent } from "@traycer-clients/shared/platform/browser-annotation";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { attachBrowserAnnotation } from "@/lib/browser-view/annotation/browser-annotation-attach";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { createStubBrowserAnnotationPayloadFor } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";

vi.mock("@/lib/browser-view/annotation/browser-annotation-attach", () => ({
  attachBrowserAnnotation: vi.fn(),
}));

const EMPTY_ROUTE: AnnotationRoute = {
  targets: [],
  defaultChatId: null,
};

const routeState = vi.hoisted((): { current: AnnotationRoute } => ({
  current: {
    targets: [],
    defaultChatId: null,
  },
}));

vi.mock("@/hooks/browser/use-annotation-route", () => ({
  useAnnotationRoute: () => routeState.current,
}));

const TILE = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const TARGET_CHAT_ID = "chat-target-1";

function attachedEvent(
  payload: BrowserAnnotationAttachedIpcEvent["payload"],
  png: Uint8Array<ArrayBuffer>,
  targetChatId: string,
): BrowserAnnotationAttachedIpcEvent {
  return { ...TILE, targetChatId, payload, pngBytes: png };
}

function sessionArgs(browserView: BrowserViewBridge) {
  return {
    browserView,
    tileKey: TILE,
    status: "ready" as const,
    epicId: "epic-1",
    browserHostId: "host-1",
    preferredChatId: null,
    fallbackChatId: null,
  };
}

function createBridge(): {
  readonly browserView: BrowserViewBridge;
  readonly attachedHandlers: Array<
    (change: BrowserAnnotationAttachedIpcEvent) => void
  >;
  readonly report: BrowserViewBridge["reportAnnotationAttachResult"];
  readonly start: Mock<BrowserViewBridge["startAnnotation"]>;
} {
  const attachedHandlers: Array<
    (change: BrowserAnnotationAttachedIpcEvent) => void
  > = [];
  const report = vi.fn<BrowserViewBridge["reportAnnotationAttachResult"]>(() =>
    Promise.resolve(),
  );
  const start = vi.fn<BrowserViewBridge["startAnnotation"]>(() =>
    Promise.resolve({ ok: true }),
  );
  const browserView = Object.assign(createFakeRunnerHost({}), {
    browserView: new Proxy<Record<string, unknown>>(
      {
        startAnnotation: start,
        cancelAnnotation: () => Promise.resolve(),
        setAnnotationTargetChatLabel: () => Promise.resolve(),
        reportAnnotationAttachResult: report,
        onAnnotationEvent: () => ({ dispose: () => undefined }),
        onAnnotationAttached: (
          handler: (change: BrowserAnnotationAttachedIpcEvent) => void,
        ) => {
          attachedHandlers.push(handler);
          return { dispose: () => undefined };
        },
      },
      {
        get: (target, property): unknown =>
          typeof property === "string"
            ? (target[property] ?? (() => undefined))
            : undefined,
      },
    ),
  }).browserView;
  return { browserView, attachedHandlers, report, start };
}

beforeEach(() => {
  routeState.current = EMPTY_ROUTE;
  useComposerDraftStore.setState({ drafts: {} });
  vi.mocked(attachBrowserAnnotation).mockReset();
});

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
  document.documentElement.style.removeProperty("--primary");
});

it("sends the active semantic theme when annotation starts", async () => {
  document.documentElement.style.setProperty("--primary", "rgb(12, 34, 56)");
  const { browserView, start } = createBridge();
  const { result } = renderHook(() =>
    useBrowserAnnotationSession(sessionArgs(browserView)),
  );

  act(() => {
    result.current.toggle();
  });

  await waitFor(() => {
    expect(start).toHaveBeenCalledTimes(1);
  });
  expect(start.mock.calls[0]?.[0].theme.primary).toBe("rgb(12, 34, 56)");
});

describe("useBrowserAnnotationSession attach ack", () => {
  it("attaches to the event targetChatId even when the route has no default", async () => {
    vi.mocked(attachBrowserAnnotation).mockImplementation((input) => {
      useComposerDraftStore.getState().addBrowserAnnotation(input.chatId, {
        kind: "browser-annotation",
        ...input.payload,
        imageFileName: `browser-annotation-${input.payload.annotationId}.png`,
        imageHash: "hash-target",
      });
      return Promise.resolve({ status: "attached" });
    });
    const { browserView, attachedHandlers, report } = createBridge();
    renderHook(() => useBrowserAnnotationSession(sessionArgs(browserView)));
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-target",
      tabId: "tab-target",
      sessionId: "session-target",
      comment: "routed by overlay",
    });
    attachedHandlers[0](attachedEvent(stub.payload, stub.png, TARGET_CHAT_ID));
    await waitFor(() => {
      expect(report).toHaveBeenCalledWith({
        annotationId: "ann-target",
        status: "attached",
      });
    });
    expect(attachBrowserAnnotation).toHaveBeenCalledWith({
      chatId: TARGET_CHAT_ID,
      payload: stub.payload,
      png: stub.png,
    });
    expect(
      useComposerDraftStore.getState().drafts[TARGET_CHAT_ID]
        ?.browserAnnotations,
    ).toHaveLength(1);
  });

  it("sends attached after the record lands on the draft", async () => {
    routeState.current = {
      targets: [{ chatId: "chat-ok", label: "Plan" }],
      defaultChatId: "chat-ok",
    };
    vi.mocked(attachBrowserAnnotation).mockImplementation((input) => {
      useComposerDraftStore.getState().addBrowserAnnotation(input.chatId, {
        kind: "browser-annotation",
        ...input.payload,
        imageFileName: `browser-annotation-${input.payload.annotationId}.png`,
        imageHash: "hash-ok",
      });
      return Promise.resolve({ status: "attached" });
    });
    const { browserView, attachedHandlers, report } = createBridge();
    renderHook(() => useBrowserAnnotationSession(sessionArgs(browserView)));
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-ok",
      tabId: "tab-ok",
      sessionId: "session-ok",
      comment: "landed",
    });
    attachedHandlers[0](attachedEvent(stub.payload, stub.png, "chat-ok"));
    await waitFor(() => {
      expect(report).toHaveBeenCalledWith({
        annotationId: "ann-ok",
        status: "attached",
      });
    });
    expect(
      useComposerDraftStore.getState().drafts["chat-ok"]?.browserAnnotations,
    ).toHaveLength(1);
    expect(
      useComposerDraftStore.getState().drafts["chat-ok"]?.browserAnnotations[0]
        ?.annotationId,
    ).toBe("ann-ok");
  });

  it("sends failed and stores no record when routed attach cannot store the crop", async () => {
    routeState.current = {
      targets: [{ chatId: "chat-fail", label: "Plan" }],
      defaultChatId: "chat-fail",
    };
    vi.mocked(attachBrowserAnnotation).mockResolvedValue({
      status: "store-failed",
    });
    const { browserView, attachedHandlers, report } = createBridge();
    renderHook(() => useBrowserAnnotationSession(sessionArgs(browserView)));
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-store-fail",
      tabId: "tab-fail",
      sessionId: "session-fail",
      comment: "lost crop",
    });
    attachedHandlers[0](attachedEvent(stub.payload, stub.png, "chat-fail"));
    await waitFor(() => {
      expect(report).toHaveBeenCalledWith({
        annotationId: "ann-store-fail",
        status: "failed",
      });
    });
    expect(
      useComposerDraftStore.getState().drafts["chat-fail"]?.browserAnnotations,
    ).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
