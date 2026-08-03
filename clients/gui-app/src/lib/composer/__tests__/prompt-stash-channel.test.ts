import { afterEach, describe, expect, it, vi } from "vitest";

import { publishPromptStashReset } from "@/lib/composer/prompt-stash-channel";

afterEach(() => vi.unstubAllGlobals());

describe("prompt stash reset channel", () => {
  it("does not propagate a channel construction failure", () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("channel unavailable");
        }
      },
    );

    expect(() => publishPromptStashReset()).not.toThrow();
  });

  it("closes the channel and does not propagate when postMessage fails", () => {
    const close = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage(): void {
          throw new Error("post failed");
        }

        close(): void {
          close();
        }
      },
    );

    expect(() => publishPromptStashReset()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
