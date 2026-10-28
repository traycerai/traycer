/**
 * The bot message box's report of an accepted send (`onSent`), through the
 * REAL `BotMessageComposer`: the send mutation is scripted, and each case
 * answers the send through the callbacks the box handed it, as the host's
 * answer or refusal would land.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";

/** What the box hands the send mutation for its send. */
interface SendCallbacks {
  readonly onSuccess:
    | ((response: BotConversationSendResponse) => void)
    | undefined;
  readonly onError: ((error: Error) => void) | undefined;
}

const mocks = vi.hoisted(() => ({
  send: vi.fn<
    (variables: BotConversationSendRequest, callbacks: SendCallbacks) => void
  >(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutate: mocks.send,
    isPending: false,
  }),
}));

import {
  BotMessageComposer,
  type BotComposerEdit,
} from "@/components/bots/bot-message-composer";

const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

const FAILURE: BotSendFailure = {
  failed: false,
  fail: () => undefined,
  clear: () => undefined,
};

const onSent =
  vi.fn<(response: BotConversationSendResponse, text: string) => boolean>();
const onEditEnd = vi.fn<() => void>();

function composer(edit: BotComposerEdit | null): ReactNode {
  return (
    <BotMessageComposer
      botId="bot-1"
      conversationId="conversation-channel"
      threadId={null}
      announcementId={null}
      sendable
      placeholder="Message Tracy"
      label="Message Tracy"
      testId="bot-channel-composer"
      failure={FAILURE}
      edit={edit}
      onEditEnd={onEditEnd}
      onSent={onSent}
    />
  );
}

function box(): HTMLTextAreaElement {
  const element = screen.getByRole("textbox", { name: "Message Tracy" });
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("no box");
  return element;
}

/** The callbacks the box handed its last send. */
function lastSend(): SendCallbacks {
  const call = mocks.send.mock.calls.at(-1);
  if (call === undefined) throw new Error("the box sent nothing");
  return call[1];
}

beforeEach(() => {
  // An owner that says nothing of the send's delivery, as a thread's box.
  onSent.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  mocks.send.mockReset();
  onSent.mockReset();
  onEditEnd.mockReset();
});

describe("<BotMessageComposer /> reporting a send", () => {
  async function sendQueued(saidByOwner: boolean): Promise<void> {
    const user = userEvent.setup();
    onSent.mockReturnValue(saidByOwner);
    render(composer(null));
    await user.type(box(), "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    act(() => {
      lastSend().onSuccess?.({ ...RESPONSE, delivery: "queued" });
    });
  }

  it("says a queued send was saved when its owner does not say it", async () => {
    await sendQueued(false);

    expect(screen.getByTestId("bot-channel-composer-queued").textContent).toBe(
      "Saved. The bot will read it.",
    );
  });

  it("says nothing of a queued send its owner says itself", async () => {
    await sendQueued(true);

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("bot-channel-composer-queued")).toBeNull();
  });

  it("reports the host's answer once it accepts the send, with the box cleared", async () => {
    const user = userEvent.setup();
    render(composer(null));
    await user.type(box(), "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    expect(onSent).not.toHaveBeenCalled();

    act(() => {
      lastSend().onSuccess?.(RESPONSE);
    });

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
    expect(box().value).toBe("");
  });

  it("reports nothing for a send the host refused, and keeps the text", async () => {
    const user = userEvent.setup();
    render(composer(null));
    await user.type(box(), "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    act(() => {
      lastSend().onError?.(new Error("host refused the post"));
    });

    expect(onSent).not.toHaveBeenCalled();
    expect(box().value).toBe("Is CI green?");
  });

  it("reports the send that replaced a failed message, as it ends the edit", async () => {
    const user = userEvent.setup();
    render(composer({ requestId: "request-failed", text: "Is CI green?" }));
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    act(() => {
      lastSend().onSuccess?.(RESPONSE);
    });

    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
  });

  it("reports nothing for an edit's send the person moved on from, and keeps the edit they opened since", async () => {
    const user = userEvent.setup();
    const view = render(
      composer({ requestId: "request-first", text: "Is CI green?" }),
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    const callbacks = lastSend();
    view.rerender(
      composer({ requestId: "request-second", text: "Is the nightly green?" }),
    );

    act(() => {
      callbacks.onSuccess?.(RESPONSE);
    });

    expect(onSent).not.toHaveBeenCalled();
    expect(onEditEnd).not.toHaveBeenCalled();
    expect(box().value).toBe("Is the nightly green?");
  });
});
