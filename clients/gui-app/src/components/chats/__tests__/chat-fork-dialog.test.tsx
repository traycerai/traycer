import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatForkEvent } from "@traycer/protocol/host/chat-fork/schemas";
import { ChatForkDialog } from "@/components/chats/chat-fork-dialog";
import { ChatForkIndicatorBanner } from "@/components/chats/chat-fork-indicator-banner";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";

/**
 * Per the gui-app testing rules (mount-cost lesson): stub the query hook
 * rather than mounting a deep host-client. Everything below mocks
 * `use-chat-fork-queries` directly, so no `HostClient`, no
 * `QueryClientProvider`, and no RPC transport is ever constructed.
 *
 * What jsdom CANNOT witness, and is left to dev-app verification per the
 * ticket's own testing-rules note:
 * - StrictMode double-invoke behavior around the query hooks.
 * - Whether the "Review" button and dialog close control are actually
 *   clickable in a real layout (pointer-inertness only shows up with real
 *   layout/paint, not jsdom's layout-less DOM).
 * - The real host round trip for `host.chatFork.get`/`resolve` and the
 *   E_HOST_UNSUPPORTED degrade path against an actual old host.
 */

const testState = vi.hoisted(() => ({
  event: null as ChatForkEvent | null,
  resolveMutate: vi.fn(),
}));

function sampleEvent(): ChatForkEvent {
  return {
    kind: "chat-publication-fork",
    episodeId: "episode-1",
    detectedAt: 1_000,
    cause: "sibling-of-receipt",
    diagnostic: "a copied or restored host directory is the usual cause",
    repairEpoch: 1,
    chats: [
      {
        taskId: "task-1",
        chatId: "chat-1",
        incumbent: {
          headSha256: "a".repeat(64),
          parentHeadSha256: null,
          throughRecordSeq: 10,
          capturedAt: 1_000,
          partCount: 3,
        },
        candidate: {
          headSha256: "b".repeat(64),
          parentHeadSha256: null,
          throughRecordSeq: 12,
          capturedAt: 2_000,
          partCount: 4,
        },
      },
    ],
    options: [
      {
        winners: { "chat-1": "a".repeat(64) },
        label: "keep-cloud-lineage",
        detail: "Keep the published history.",
      },
      {
        winners: { "chat-1": "b".repeat(64) },
        label: "keep-this-host-lineage",
        detail: "Keep this device's history.",
      },
    ],
  };
}

vi.mock("@/hooks/chats/use-chat-fork-queries", () => ({
  useChatForkEventQuery: () => ({
    data: { event: testState.event },
    isLoading: false,
  }),
  useChatForkResolveMutation: () => ({
    mutate: testState.resolveMutate,
    isPending: false,
  }),
  useChatForkCandidateHeadQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
  useChatForkReadCandidateHeadSupported: () => true,
}));

describe("ChatForkDialog + ChatForkIndicatorBanner", () => {
  beforeEach(() => {
    testState.event = sampleEvent();
    testState.resolveMutate.mockReset();
    useAppDialogStore.setState({ activeDialog: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("never auto-opens the dialog when a fork event is present on mount", () => {
    render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );

    // The banner (the indicator) is visible...
    expect(screen.getByText(/stopped publishing/i)).not.toBeNull();
    // ...but the dialog never opened itself just because data arrived.
    expect(screen.queryByText("Fork resolution")).toBeNull();
  });

  it("re-rendering with unchanged event data does not open the dialog either", () => {
    const { rerender } = render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );
    expect(screen.queryByText("Fork resolution")).toBeNull();

    // Simulate a reconnect/re-render: same event, fresh render pass.
    testState.event = sampleEvent();
    rerender(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );
    expect(screen.queryByText("Fork resolution")).toBeNull();
  });

  it("opens on click, and dismissing does not consume the event or hide the indicator", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Fork resolution")).not.toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("Fork resolution")).toBeNull();
    // Dismissal is local UI state only - the indicator (driven by the SAME
    // query data) is untouched, and the query itself was never told
    // anything happened.
    expect(screen.getByText(/stopped publishing/i)).not.toBeNull();

    // Reopen from the indicator - the exact requirement ticket 09 names.
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Fork resolution")).not.toBeNull();
  });

  it("submits the selected option's label with the current episodeId", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByText("Keep the published history"));
    await user.click(screen.getByRole("button", { name: "Confirm choice" }));

    expect(testState.resolveMutate).toHaveBeenCalledWith(
      { episodeId: "episode-1", label: "keep-cloud-lineage" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("renders nothing when no fork event is open", () => {
    testState.event = null;
    render(<ChatForkIndicatorBanner />);
    expect(screen.queryByText(/stopped publishing/i)).toBeNull();
  });
});
