import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";

import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  STUB_ANNOTATION_ELEMENT,
  STUB_ANNOTATION_PARAGRAPH,
  createStubBrowserAnnotationPayloadFor,
} from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";
import {
  drainImages,
  installIdbWorking,
} from "@/lib/browser-view/annotation/__tests__/browser-annotation-idb-fixtures";
import {
  getImageBytes,
  putImage,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const idbData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("idb-keyval", async () => {
  // Dynamic import: the factory is hoisted above the static imports, so the
  // fixture binding is not initialized yet when this runs.
  const { createIdbKeyvalMock } =
    await import("@/lib/browser-view/annotation/__tests__/browser-annotation-idb-mock");
  return createIdbKeyvalMock(idbData);
});

const LONG_COMMENT =
  "Please enlarge the hero heading and add more breathing room under the fold so the page feels less cramped on first paint";

const EXTRA_ELEMENT: BrowserAnnotationRecord["elements"][number] = {
  ...STUB_ANNOTATION_ELEMENT,
  selector: "main > button",
  tagName: "button",
  classNames: [...STUB_ANNOTATION_ELEMENT.classNames],
  outerHtml: "<button>Go</button>",
  textPreview: "Go",
  ariaRole: "button",
  accessibleName: "Go",
};

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

function makeRecord(
  overrides: Partial<BrowserAnnotationRecord> & {
    readonly annotationId: string;
    readonly tabId: string;
  },
): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: overrides.annotationId,
    tabId: overrides.tabId,
    sessionId: overrides.sessionId ?? "session-card",
    origin: overrides.origin ?? "https://example.com",
    pageUrl: overrides.pageUrl ?? "https://example.com/",
    pageTitle: overrides.pageTitle ?? "Example Domain",
    capturedAt: overrides.capturedAt ?? 1_700_000_000_000,
    comment: overrides.comment ?? LONG_COMMENT,
    counts: overrides.counts ?? { elements: 2, regions: 0, strokes: 1 },
    elements: overrides.elements ?? [
      STUB_ANNOTATION_ELEMENT,
      STUB_ANNOTATION_PARAGRAPH,
    ],
    imageFileName:
      overrides.imageFileName ??
      `browser-annotation-${overrides.annotationId}.png`,
    imageHash: overrides.imageHash ?? "missing-hash",
    droppedElementCount: overrides.droppedElementCount ?? 0,
  };
}

function tab(
  overrides: Partial<BrowserTabInfo> & Pick<BrowserTabInfo, "tabId" | "url">,
): BrowserTabInfo {
  return {
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

function session(
  overrides: Partial<BrowserSessionInfo> &
    Pick<BrowserSessionInfo, "sessionId" | "tabs">,
): BrowserSessionInfo {
  return {
    epicId: "epic-1",
    hostId: "host-1",
    profile: "primary",
    lastActivityAt: 2,
    ...overrides,
    runtime: overrides.runtime ?? { kind: "electron", revision: 0 },
  };
}

function sessionsState(
  items: ReadonlyArray<BrowserSessionInfo>,
): BrowserSessionsState {
  return {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    items,
    errorMessage: null,
    retry: vi.fn(),
    openTab: vi.fn(() => Promise.reject(new Error("not used"))),
    closeTab: vi.fn(() => Promise.resolve()),
  };
}

async function landingFetcher(hash: string): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string | null;
}> {
  const bytes = await getImageBytes(hash);
  if (bytes === undefined) {
    throw new Error(`Landing image ${hash} unavailable`);
  }
  return { bytes, mediaType: null };
}

function renderCard(
  record: BrowserAnnotationRecord,
  onRemove: (annotationId: string) => void,
  items: ReadonlyArray<BrowserSessionInfo> | null,
): void {
  const card = (
    <BrowserAnnotationCard
      record={record}
      onRemove={onRemove}
      imageFetcher={landingFetcher}
      sessionObjectUrl={sessionObjectUrl}
    />
  );
  if (items === null) {
    render(card);
    return;
  }
  render(
    <BrowserSessionsContext.Provider value={sessionsState(items)}>
      {card}
    </BrowserSessionsContext.Provider>,
  );
}

beforeEach(async () => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  installIdbWorking(idbData, idbGet, idbSet, idbDel);
  await drainImages();
  vi.clearAllMocks();
  installIdbWorking(idbData, idbGet, idbSet, idbDel);
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(async () => {
  cleanup();
  await drainImages();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("BrowserAnnotationCard", () => {
  it("shows a pulse placeholder when the crop hash has no bytes", () => {
    renderCard(
      makeRecord({ annotationId: "ann-placeholder", tabId: "tab-1" }),
      vi.fn(),
      null,
    );

    const card = screen.getByTestId("browser-annotation-card");
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders the thumbnail when putImage has stored the crop", async () => {
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-thumb",
      tabId: "tab-thumb",
      sessionId: "session-card",
      comment: LONG_COMMENT,
    });
    const hash = await putImage(stub.png);
    renderCard(
      makeRecord({
        annotationId: "ann-thumb",
        tabId: "tab-thumb",
        imageHash: hash,
      }),
      vi.fn(),
      null,
    );

    const img = screen
      .getByTestId("browser-annotation-card")
      .querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toMatch(/^blob:mock\//);
  });

  it("renders the truncated comment text, or No comment when empty", () => {
    const { rerender } = render(
      <BrowserAnnotationCard
        record={makeRecord({
          annotationId: "ann-comment",
          tabId: "tab-1",
          comment: LONG_COMMENT,
        })}
        onRemove={vi.fn()}
        imageFetcher={landingFetcher}
        sessionObjectUrl={sessionObjectUrl}
      />,
    );
    const comment = screen.getByText(LONG_COMMENT);
    expect(comment.className).toContain("truncate");

    rerender(
      <BrowserAnnotationCard
        record={makeRecord({
          annotationId: "ann-comment",
          tabId: "tab-1",
          comment: "   ",
        })}
        onRemove={vi.fn()}
        imageFetcher={landingFetcher}
        sessionObjectUrl={sessionObjectUrl}
      />,
    );
    expect(screen.getByText("No comment")).toBeTruthy();
  });

  it("renders as a compact chip without element tag badges", () => {
    renderCard(
      makeRecord({
        annotationId: "ann-tags",
        tabId: "tab-1",
        elements: [
          STUB_ANNOTATION_ELEMENT,
          STUB_ANNOTATION_PARAGRAPH,
          EXTRA_ELEMENT,
        ],
      }),
      vi.fn(),
      null,
    );

    const card = screen.getByTestId("browser-annotation-card");
    expect(card.className).toContain("h-10");
    expect(card.className).toContain("max-w-[min(70vw,16rem)]");
    expect(card.className).toContain("shrink-0");
    expect(screen.queryByText("h1")).toBeNull();
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("renders the counts line as 2 elements · 1 drawing", () => {
    renderCard(
      makeRecord({
        annotationId: "ann-counts",
        tabId: "tab-1",
        counts: { elements: 2, regions: 0, strokes: 1 },
      }),
      vi.fn(),
      null,
    );

    expect(screen.getByText(/2 elements · 1 drawing/)).toBeTruthy();
  });

  it("appends over-budget copy when droppedElementCount is nonzero", () => {
    renderCard(
      makeRecord({
        annotationId: "ann-dropped",
        tabId: "tab-1",
        counts: { elements: 9, regions: 0, strokes: 0 },
        droppedElementCount: 3,
      }),
      vi.fn(),
      null,
    );

    expect(screen.getByText(/9 elements, 3 over budget/)).toBeTruthy();
  });

  it("shows no staleness hint when the live tab is still on the annotated URL", () => {
    const record = makeRecord({
      annotationId: "ann-fresh",
      tabId: "tab-1",
      sessionId: "session-card",
      pageUrl: "https://example.com/",
    });
    renderCard(record, vi.fn(), [
      session({
        sessionId: "session-card",
        tabs: [tab({ tabId: "tab-1", url: "https://example.com/" })],
      }),
    ]);

    expect(screen.queryByText(/page has navigated/)).toBeNull();
    expect(screen.queryByText(/source tab closed/)).toBeNull();
  });

  it("shows the navigated hint when the sessions provider reports a new URL", () => {
    const record = makeRecord({
      annotationId: "ann-nav",
      tabId: "tab-1",
      sessionId: "session-card",
      pageUrl: "https://example.com/",
    });
    renderCard(record, vi.fn(), [
      session({
        sessionId: "session-card",
        tabs: [tab({ tabId: "tab-1", url: "https://example.com/pricing" })],
      }),
    ]);

    expect(screen.getByText(/page has navigated/)).toBeTruthy();
  });

  it("does not claim closed for an unregistered tabId on a live session", () => {
    const record = makeRecord({
      annotationId: "ann-unknown-tab",
      tabId: "tab-unregistered",
      sessionId: "session-card",
    });
    renderCard(record, vi.fn(), [
      session({
        sessionId: "session-card",
        tabs: [tab({ tabId: "tab-other", url: "https://example.com/" })],
      }),
    ]);

    expect(screen.queryByText(/source tab closed/)).toBeNull();
    expect(screen.queryByText(/page has navigated/)).toBeNull();
  });

  it("does not claim closed when no matching session is listed", () => {
    const record = makeRecord({
      annotationId: "ann-no-session",
      tabId: "tab-1",
      sessionId: "session-missing",
    });
    renderCard(record, vi.fn(), [
      session({
        sessionId: "session-other",
        tabs: [tab({ tabId: "tab-1", url: "https://example.com/" })],
      }),
    ]);

    expect(screen.queryByText(/source tab closed/)).toBeNull();
  });

  it("shows the closed hint when the live tab is closing", () => {
    const record = makeRecord({
      annotationId: "ann-closing",
      tabId: "tab-1",
      sessionId: "session-card",
    });
    renderCard(record, vi.fn(), [
      session({
        sessionId: "session-card",
        tabs: [
          tab({
            tabId: "tab-1",
            url: "https://example.com/",
            status: "closing",
          }),
        ],
      }),
    ]);

    expect(screen.getByText(/source tab closed/)).toBeTruthy();
  });

  it("X calls onRemove with the annotationId", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderCard(
      makeRecord({ annotationId: "ann-x", tabId: "tab-1" }),
      onRemove,
      null,
    );

    await user.click(screen.getByRole("button", { name: "Remove annotation" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("ann-x");
  });
});

describe("BrowserAnnotationCard attachments", () => {
  it("shares the composer image scroller as compact leading chips", () => {
    const record = makeRecord({
      annotationId: "ann-scroller",
      tabId: "tab-a",
      comment: "from the overlay",
    });
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation("chat-scroller", record);

    render(
      <AttachmentStrip
        content={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "imageAttachment",
                  attrs: {
                    id: "img-1",
                    fileName: "image.png",
                    b64content: "img-1",
                    mimeType: "image/png",
                    size: 5,
                  },
                },
              ],
            },
          ],
        }}
        onRemoveImage={() => undefined}
        fetcher={() => Promise.reject(new Error("unused"))}
        sessionObjectUrl={() => null}
        leadingAttachments={
          <BrowserAnnotationCard
            record={record}
            onRemove={() => undefined}
            imageFetcher={landingFetcher}
            sessionObjectUrl={sessionObjectUrl}
          />
        }
      />,
    );

    const strip = document.querySelector("[data-composer-attachment-strip]");
    const row = strip?.firstElementChild;
    const card = screen.getByTestId("browser-annotation-card");
    expect(row?.className).toContain("w-max");
    expect(row?.className).not.toContain("flex-wrap");
    expect(row?.contains(card)).toBe(true);
    expect(card.className).toContain("h-10");
    expect(
      row?.contains(screen.getByRole("button", { name: /Open Image#1/ })),
    ).toBe(true);
  });
});
