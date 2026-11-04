/**
 * A bot's "Needs you" post through the REAL markdown path
 * (`AgentReferenceMarkdown` over `TraycerMarkdown`) in a channel, where no
 * epic is open: an agent written as `<traycer-chat>` is a chip that opens its
 * task and focuses that chat, and a pull request written as a markdown link
 * is an anchor to it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "active-host-1",
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));
vi.mock("@/components/epic-canvas/view-tab-context", () => ({
  useEpicViewTabId: () => null,
}));

const navigateToTabIntent = vi.fn();
const openOrFocusEpicIntent = vi.fn(
  (input: { epicId: string; focus: unknown }) => ({ kind: "epic", ...input }),
);
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (...args: unknown[]) => {
    navigateToTabIntent(...args);
  },
  openOrFocusEpicIntent: (input: { epicId: string; focus: unknown }) =>
    openOrFocusEpicIntent(input),
}));

import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";

const PR_URL = "https://github.com/example/repo/pull/42";

beforeEach(() => {
  navigateToTabIntent.mockClear();
  openOrFocusEpicIntent.mockClear();
});

afterEach(cleanup);

describe("a Needs you post in a channel with no open epic", () => {
  it("draws an agent as a chip that opens its task and focuses that chat, and a pull request as a link", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown={`- <traycer-chat epicId="epic-7" chatId="chat-9">Fix the build</traycer-chat> waits on a steer\n- [Review comments on #42](${PR_URL})`}
          proseSize="compact"
          quotable={false}
          components={null}
        />
      </QueryClientProvider>,
    );

    const chip = screen.getByRole("button", { name: "Fix the build" });
    expect(chip.getAttribute("data-traycer-ref")).toBe("chat");
    const anchor = container.querySelector(`a[href="${PR_URL}"]`);
    expect(anchor?.textContent).toBe("Review comments on #42");

    fireEvent.click(chip);

    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-7");
    expect(arg.focus).toMatchObject({ focusArtifactId: "chat-9" });
  });
});
