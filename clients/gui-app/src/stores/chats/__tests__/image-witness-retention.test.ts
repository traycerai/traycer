import { expect, it } from "vitest";
import { createImageWitnessStore } from "@/stores/chats/image-witness-store";

it("bounds the diagnostic history when many distinct image sources are witnessed", () => {
  const witnesses = createImageWitnessStore();
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
  }

  expect(witnesses.truncatedSources().size).toBeLessThanOrEqual(512);
  expect(
    witnesses.truncatedSources().has("message-1024\u0000image-source-1024"),
  ).toBe(true);
});
