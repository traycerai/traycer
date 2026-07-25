import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEpicAttachmentBytesPresence } from "@/lib/attachments/use-attachment-blob-src";

const mocks = vi.hoisted(() => ({
  snapshotLoaded: false,
  hasAttachmentBytes: vi.fn((hash: string) => hash === "present-hash"),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => null,
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({
        hasAttachmentBytes: mocks.hasAttachmentBytes,
      }),
    },
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotLoaded: () => mocks.snapshotLoaded,
}));

afterEach(() => {
  mocks.snapshotLoaded = false;
  mocks.hasAttachmentBytes.mockClear();
});

describe("useEpicAttachmentBytesPresence", () => {
  it("returns no predicate until the root snapshot is loaded", () => {
    const { result, rerender } = renderHook(() =>
      useEpicAttachmentBytesPresence(),
    );

    expect(result.current).toBeNull();

    mocks.snapshotLoaded = true;
    rerender();

    const hasAttachmentBytes = result.current;
    if (hasAttachmentBytes === null) {
      throw new Error("expected attachment presence after snapshot readiness");
    }
    expect(hasAttachmentBytes("present-hash")).toBe(true);
    expect(hasAttachmentBytes("missing-hash")).toBe(false);
  });
});
