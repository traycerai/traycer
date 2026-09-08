import { describe, expect, it } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";

import { annotationStalenessHint } from "@/lib/browser-view/annotation/browser-annotation-staleness";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import { STUB_ANNOTATION_ELEMENT } from "./browser-annotation-fixtures";

function record(
  overrides: Partial<BrowserAnnotationRecord>,
): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: overrides.annotationId ?? "ann-1",
    tabId: overrides.tabId ?? "tab-1",
    sessionId: overrides.sessionId ?? "session-1",
    origin: overrides.origin ?? "https://example.com",
    pageUrl: overrides.pageUrl ?? "https://example.com/",
    pageTitle: overrides.pageTitle ?? "Example",
    capturedAt: overrides.capturedAt ?? 1,
    comment: overrides.comment ?? "",
    counts: overrides.counts ?? { elements: 1, regions: 0, strokes: 0 },
    elements: overrides.elements ?? [STUB_ANNOTATION_ELEMENT],
    imageFileName: overrides.imageFileName ?? "browser-annotation-ann-1.png",
    imageHash: overrides.imageHash ?? "hash-1",
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

describe("annotationStalenessHint", () => {
  const annotated = record({});

  it("makes no claim when the sessions feed is absent", () => {
    expect(annotationStalenessHint(annotated, null)).toBeNull();
  });

  it("makes no claim when the live tab is still on the annotated URL", () => {
    expect(
      annotationStalenessHint(annotated, [
        session({
          sessionId: "session-1",
          tabs: [tab({ tabId: "tab-1", url: "https://example.com/" })],
        }),
      ]),
    ).toBeNull();
  });

  it("returns navigated when the known tab's URL changed", () => {
    expect(
      annotationStalenessHint(annotated, [
        session({
          sessionId: "session-1",
          tabs: [tab({ tabId: "tab-1", url: "https://example.com/pricing" })],
        }),
      ]),
    ).toBe("navigated");
  });

  it("returns closed only when the known tab is closing or crashed", () => {
    expect(
      annotationStalenessHint(annotated, [
        session({
          sessionId: "session-1",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://example.com/",
              status: "closing",
            }),
          ],
        }),
      ]),
    ).toBe("closed");
    expect(
      annotationStalenessHint(annotated, [
        session({
          sessionId: "session-1",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://example.com/",
              status: "crashed",
            }),
          ],
        }),
      ]),
    ).toBe("closed");
  });

  it("does not claim closed for an unregistered tabId on a real session", () => {
    expect(
      annotationStalenessHint(record({ tabId: "tab-unregistered" }), [
        session({
          sessionId: "session-1",
          tabs: [tab({ tabId: "tab-other", url: "https://example.com/" })],
        }),
      ]),
    ).toBeNull();
  });

  it("does not claim closed when no matching session is listed", () => {
    expect(
      annotationStalenessHint(annotated, [
        session({
          sessionId: "session-other",
          tabs: [tab({ tabId: "tab-1", url: "https://example.com/" })],
        }),
      ]),
    ).toBeNull();
  });
});
