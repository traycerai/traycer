import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportSentChatMessage,
  subscribeSentChatMessages,
  type SentChatMessage,
} from "@/components/share-on-x/sent-messages";

const MESSAGE: SentChatMessage = { text: "thanks", epicId: "e1", hostId: null };

describe("reportSentChatMessage", () => {
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  });

  it("keeps an accepted send accepted when a listener throws, and still reaches the next listener", async () => {
    const after = vi.fn();
    unsubscribes.push(
      subscribeSentChatMessages(() => {
        throw new Error("quota exceeded");
      }),
      subscribeSentChatMessages(after),
    );

    expect(reportSentChatMessage(true, MESSAGE)).toBe(true);
    await expect(
      reportSentChatMessage(Promise.resolve(true), MESSAGE),
    ).resolves.toBe(true);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("reports nothing for a refused send", async () => {
    const listener = vi.fn();
    unsubscribes.push(subscribeSentChatMessages(listener));

    expect(reportSentChatMessage(false, MESSAGE)).toBe(false);
    await expect(
      reportSentChatMessage(Promise.resolve(false), MESSAGE),
    ).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
