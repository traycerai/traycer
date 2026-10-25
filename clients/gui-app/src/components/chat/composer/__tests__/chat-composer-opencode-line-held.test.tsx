import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OpencodeLineHeld } from "@traycer/protocol/common/opencode-line";
import { ChatComposerOpencodeLineHeld } from "@/components/chat/composer/chat-composer-opencode-line-held";
import { ChatOpencodeLineHeldContext } from "@/hooks/harnesses/chat-opencode-line-context";

function renderHeld(held: OpencodeLineHeld | null): void {
  render(
    <ChatOpencodeLineHeldContext.Provider value={held}>
      <ChatComposerOpencodeLineHeld />
    </ChatOpencodeLineHeldContext.Provider>,
  );
}

describe("ChatComposerOpencodeLineHeld", () => {
  afterEach(cleanup);

  it.each([
    [
      { line: 1, reason: "background_work" },
      "Stays on OpenCode 1.x until its background work ends.",
    ],
    [
      { line: 1, reason: "model_unavailable" },
      "Stays on OpenCode 1.x until you pick a model OpenCode 2.x offers.",
    ],
    [
      { line: 1, reason: "binary_unavailable" },
      "Stays on OpenCode 1.x until OpenCode 2.x is ready.",
    ],
    [
      { line: 2, reason: "background_work" },
      "Stays on OpenCode 2.x until its background work ends.",
    ],
    [
      { line: 2, reason: "model_unavailable" },
      "Stays on OpenCode 2.x until you pick a model OpenCode 1.x offers.",
    ],
    [
      { line: 2, reason: "binary_unavailable" },
      "Stays on OpenCode 2.x until OpenCode 1.x is ready.",
    ],
  ] as const)("says why a chat held as %o stays put", (held, copy) => {
    renderHeld(held);
    expect(screen.getByRole("status").textContent).toBe(copy);
  });

  it("renders nothing when no hold applies", () => {
    renderHeld(null);
    expect(screen.queryByTestId("chat-composer-opencode-line-held")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
