import { expect, it, vi } from "vitest";
import { createImageWitnessStore } from "@/stores/chats/image-witness-store";

it("bounds the diagnostic history when many distinct image sources are witnessed", () => {
  const witnesses = createImageWitnessStore();
  let halfwayBytes = 0;
  for (let index = 0; index < 2_048; index += 1) {
    const source = `image-source-${index}`;
    witnesses.record(`message-${index}`, {
      source,
      canonicalSource: source,
      width: 10,
      height: 10,
      state: "resolved",
      attachmentHash: index.toString(16).padStart(64, "0"),
      mediaType: "image/png",
    });
    if (index === 1_023) {
      halfwayBytes = witnesses.retainedSize().estimatedHeapBytes;
    }
  }

  expect(witnesses.retainedSize().estimatedHeapBytes).toBeLessThan(
    halfwayBytes * 1.5,
  );
  expect(witnesses.truncatedSources().size).toBeLessThanOrEqual(512);
  expect(
    witnesses.truncatedSources().has("message-1024\u0000image-source-1024"),
  ).toBe(true);
});

it("charges reset floors that outlive transcript rows and releases them on invalidation", () => {
  const witnesses = createImageWitnessStore();
  const changed = vi.fn();
  witnesses.setRetainedSizeListener(changed);
  for (let index = 0; index < 1_000; index += 1) {
    witnesses.resetServedRecord(`message-${index}`);
  }
  expect(witnesses.retainedSize().estimatedHeapBytes).toBeGreaterThan(50_000);
  expect(changed).toHaveBeenCalledTimes(1_000);

  witnesses.invalidateAll();
  expect(witnesses.retainedSize()).toEqual({
    rawBytes: 0,
    estimatedHeapBytes: 0,
  });
});
