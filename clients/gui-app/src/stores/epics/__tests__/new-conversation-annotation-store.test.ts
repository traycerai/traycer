import { afterEach, describe, expect, it } from "vitest";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  readNewConversationAnnotations,
  useNewConversationAnnotationStore,
} from "../new-conversation-annotation-store";

function record(annotationId: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId,
    source: {
      kind: "canvas",
      artifactId: "canvas-1",
      artifactTitle: "Canvas",
      boardPath: "boards/home.html",
      canvasPage: null,
    },
    capturedAt: 1,
    comment: "",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: null,
    imageHash: null,
    droppedElementCount: 0,
  };
}

afterEach(() => {
  useNewConversationAnnotationStore.setState({ byEpicId: {} });
});

describe("the new-conversation annotation sidecar", () => {
  it("keeps each epic's cards apart and removes one by id", () => {
    const store = useNewConversationAnnotationStore.getState();
    store.add("epic-1", record("a"));
    store.add("epic-1", record("b"));
    store.add("epic-2", record("c"));

    store.remove("epic-1", "a");

    expect(
      readNewConversationAnnotations("epic-1").map((r) => r.annotationId),
    ).toEqual(["b"]);
    expect(
      readNewConversationAnnotations("epic-2").map((r) => r.annotationId),
    ).toEqual(["c"]);
  });

  it("clears one epic and reads an unknown epic as empty", () => {
    const store = useNewConversationAnnotationStore.getState();
    store.add("epic-1", record("a"));
    store.add("epic-2", record("c"));

    store.clear("epic-1");

    expect(readNewConversationAnnotations("epic-1")).toEqual([]);
    expect(readNewConversationAnnotations("epic-2")).toHaveLength(1);
  });
});
