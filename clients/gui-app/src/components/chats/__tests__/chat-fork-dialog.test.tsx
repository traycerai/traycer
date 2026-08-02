import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatForkEvent } from "@traycer/protocol/host/chat-fork/schemas";
import { ChatForkDialog } from "@/components/chats/chat-fork-dialog";
import { ChatForkIndicatorBanner } from "@/components/chats/chat-fork-indicator-banner";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Per the gui-app testing rules (mount-cost lesson): stub the query hook
 * rather than mounting a deep host-client. Everything below mocks
 * `use-chat-fork-queries` directly, so no `HostClient`, no
 * `QueryClientProvider`, and no RPC transport is ever constructed. The
 * challenger candidate needs no query at all - it is identified by summary
 * metadata already on the event payload, never separately fetched.
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
        repairEpoch: 1,
        forkOccurrenceId: "occ-1",
      },
    ],
    options: [
      {
        winners: { "chat-1": "a".repeat(64) },
        label: "keep-cloud-lineage",
        detail: "The candidate's divergent tail is preserved as a new cloned chat.",
      },
      {
        winners: { "chat-1": "b".repeat(64) },
        label: "keep-this-host-lineage",
        detail: "The published tail is preserved as a new cloned chat.",
      },
    ],
  };
}

/** Every string this dialog renders, gathered so a wording regression can be
 * asserted against the whole surface at once rather than one string at a
 * time. */
function allRenderedStrings(event: ChatForkEvent): readonly string[] {
  const strings: string[] = [event.diagnostic];
  for (const chat of event.chats) strings.push(chat.chatId);
  for (const option of event.options) strings.push(option.detail);
  return strings;
}

/**
 * Stubbed rather than mounted: `CloudChatDialog` pulls in the full
 * cloud-chat-transcript read pipeline (`useHostClient`, TanStack Query), and
 * this suite only needs to assert that the Published card WIRES an identity
 * into it - not that the read pipeline itself works, which is that
 * component's own suite's job. Mounting it here would be exactly the
 * mount-cost mistake the module docblock above warns against.
 */
vi.mock("@/components/epic-canvas/sidebar/cloud-chat-dialog", () => ({
  CloudChatDialog: (props: {
    readonly identity: { readonly chatId: string } | null;
    readonly open: boolean;
  }) =>
    props.open && props.identity !== null ? (
      <div data-testid="cloud-chat-dialog-stub">
        Published copy of {props.identity.chatId}
      </div>
    ) : null,
}));

vi.mock("@/hooks/chats/use-chat-fork-queries", () => ({
  useChatForkEventQuery: () => ({
    data: { event: testState.event },
    isLoading: false,
  }),
  useChatForkResolveMutation: () => ({
    mutate: testState.resolveMutate,
    isPending: false,
  }),
}));

describe("ChatForkDialog + ChatForkIndicatorBanner", () => {
  beforeEach(() => {
    testState.event = sampleEvent();
    testState.resolveMutate.mockReset();
    useAppDialogStore.setState({ activeDialog: null });
    // The Published card's "View" resolves an owner identity off this store
    // synchronously (see `PublishedCandidateCard`) - a fork event only ever
    // exists for an authenticated session, so tests set it the same way.
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "owner-1", username: "owner" },
    });
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

    expect(testState.resolveMutate).toHaveBeenCalledTimes(1);
    const [params, options] = testState.resolveMutate.mock.calls[0] as [
      { episodeId: string; label: string },
      { onSuccess: unknown },
    ];
    expect(params).toEqual({ episodeId: "episode-1", label: "keep-cloud-lineage" });
    expect(typeof options.onSuccess).toBe("function");
  });

  it("claims success only when EVERY chat resolved - a partial or empty result set does not", async () => {
    // Spec 4. The confirmation screen is the only thing the owner reads after
    // pressing Confirm, so "Decision recorded" over a set where one chat came
    // back `not-ready` (or where nothing came back at all) is a lie that
    // stops them retrying. `every` on an empty array is vacuously true, which
    // is exactly how the empty case used to render as a decision.
    const cases: {
      readonly results: readonly { readonly status: string }[];
      readonly title: string;
    }[] = [
      { results: [], title: "Still finalizing" },
      {
        results: [{ status: "resolved" }, { status: "not-ready" }],
        title: "Still finalizing",
      },
      {
        results: [{ status: "resolved" }, { status: "resolved" }],
        title: "Decision recorded",
      },
    ];

    for (const [index, expected] of cases.entries()) {
      testState.resolveMutate.mockImplementation(
        (
          _params: unknown,
          options: {
            readonly onSuccess: (data: {
              readonly outcome: string;
              readonly results: readonly unknown[];
            }) => void;
          },
        ) => {
          options.onSuccess({
            outcome: "resolved",
            results: expected.results.map((r, i) => ({
              taskId: "task-1",
              chatId: `chat-${index}-${i}`,
              cloneChatId: null,
              repairEpoch: 2,
              ...r,
            })),
          });
        },
      );
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

      expect(screen.getByText(expected.title)).toBeTruthy();
      cleanup();
      useAppDialogStore.getState().closeDialog();
    }
  });

  it("renders nothing when no fork event is open", () => {
    testState.event = null;
    render(<ChatForkIndicatorBanner />);
    expect(screen.queryByText(/stopped publishing/i)).toBeNull();
  });

  it("the Published card opens the cloud-chat read surface; the Candidate card offers no raw-content view", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Review" }));

    // Exactly one "View" - the Published card. The Candidate card is
    // identified by its summary metadata alone (see `CandidateStats`); it
    // offers no inspectable content at all.
    const viewLinks = screen.getAllByRole("button", { name: "View" });
    expect(viewLinks).toHaveLength(1);
    await user.click(viewLinks[0]);

    expect(screen.getByTestId("cloud-chat-dialog-stub")).not.toBeNull();
    expect(screen.getByText("Published copy of chat-1")).not.toBeNull();
  });

  it("never mentions a device or host identity outside the one sanctioned diagnostic sentence", async () => {
    const user = userEvent.setup();
    const event = sampleEvent();
    testState.event = event;
    render(
      <>
        <ChatForkIndicatorBanner />
        <ChatForkDialog />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Review" }));

    // `diagnostic` is the ONE sanctioned place machine provenance appears
    // (worded as a CAUSE, never an identity) - excluded here so this test
    // asserts the actual ruling ("never by device") rather than a stricter
    // one nothing implements.
    const diagnosticNode = screen.getByText(event.diagnostic);
    const rendered = document.body.textContent.replace(event.diagnostic, "");
    expect(diagnosticNode).not.toBeNull();
    for (const s of allRenderedStrings(event).filter(
      (s) => s !== event.diagnostic,
    )) {
      expect(rendered).toContain(s);
    }
    expect(rendered).not.toMatch(/\bdevice\b/i);
    expect(rendered).not.toMatch(/\bhost\b/i);
  });

  it("does not offer an option that covers no chat in the episode", () => {
    testState.event = {
      ...sampleEvent(),
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
          // No composable candidate - the second option's winners map is empty.
          candidate: null,
          repairEpoch: 1,
          forkOccurrenceId: "occ-1",
        },
      ],
      options: [
        {
          winners: { "chat-1": "a".repeat(64) },
          label: "keep-cloud-lineage",
          detail: "The candidate's divergent tail is preserved as a new cloned chat.",
        },
        {
          winners: {},
          label: "keep-this-host-lineage",
          detail: "The published tail is preserved as a new cloned chat.",
        },
      ],
    };
    useAppDialogStore.setState({ activeDialog: "chat-fork" });
    render(<ChatForkDialog />);
    expect(screen.getByText("Keep the published history")).not.toBeNull();
    expect(screen.queryByText("Keep the candidate's history")).toBeNull();
  });
});
