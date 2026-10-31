/**
 * The bot message box's report of an accepted send (`onSent`), through the
 * REAL `BotMessageComposer`: the send mutation is scripted, and each case
 * answers the send through the callbacks the box handed it, as the host's
 * answer or refusal would land.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
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
  /** Each send's callbacks, to the send settling once the box has taken its outcome. */
  settled: new WeakMap<SendCallbacks, Promise<void>>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  // The box settles its send through the promise; the case settles it
  // through the callbacks the promise is built on.
  useBotConversationSendMutation: () => ({
    mutateAsync: (variables: BotConversationSendRequest) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<BotConversationSendResponse>();
      const callbacks: SendCallbacks = { onSuccess: resolve, onError: reject };
      mocks.settled.set(
        callbacks,
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
      mocks.send(variables, callbacks);
      return promise;
    },
    isPending: false,
  }),
}));

import {
  BotIdentityContext,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import { useAuthStore } from "@/stores/auth/auth-store";
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
      seed={null}
      keptDraft={null}
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

/** Settles a send of the box as the host's answer does, and waits for the box to take it. */
async function settleSend(
  callbacks: SendCallbacks,
  outcome: (callbacks: SendCallbacks) => void,
): Promise<void> {
  await act(async () => {
    outcome(callbacks);
    await mocks.settled.get(callbacks);
  });
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
    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.({ ...RESPONSE, delivery: "queued" }),
    );
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

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
    expect(box().value).toBe("");
  });

  it("reports nothing for a send the host refused, and keeps the text", async () => {
    const user = userEvent.setup();
    render(composer(null));
    await user.type(box(), "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onError?.(new Error("host refused the post")),
    );

    expect(onSent).not.toHaveBeenCalled();
    expect(box().value).toBe("Is CI green?");
  });

  it("reports the send that replaced a failed message, as it ends the edit", async () => {
    const user = userEvent.setup();
    render(composer({ requestId: "request-failed", text: "Is CI green?" }));
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );

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

    await settleSend(callbacks, (sent) => sent.onSuccess?.(RESPONSE));

    expect(onSent).not.toHaveBeenCalled();
    expect(onEditEnd).not.toHaveBeenCalled();
    expect(box().value).toBe("Is the nightly green?");
  });
});

describe("<BotMessageComposer /> @ mentions", () => {
  const TEAM: BotOwner = {
    kind: "team",
    name: "Acme",
    members: [
      { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
      { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
      { userId: "u-anders", displayName: "Anders", avatarUrl: null },
      { userId: "u-anon", displayName: null, avatarUrl: null },
      { userId: "u-bob", displayName: "Bob", avatarUrl: null },
    ],
  };
  const PERSON: BotOwner = {
    kind: "person",
    userId: "u-viewer",
    name: "Andy Viewer",
    avatarUrl: null,
  };

  function mountIn(owner: BotOwner): void {
    render(
      <BotIdentityContext value={{ botId: "bot-1", title: "Tracy", owner }}>
        {composer(null)}
      </BotIdentityContext>,
    );
  }

  function optionNames(): string[] {
    return screen
      .getAllByTestId("bot-mention-option")
      .map((option) => option.getAttribute("data-user-id") ?? "");
  }

  beforeEach(() => {
    useAuthStore.setState({
      profile: {
        userId: "u-viewer",
        userName: "Andy Viewer",
        email: "andy@example.com",
        avatarUrl: null,
      },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ profile: null });
  });

  it("lists the team's matching members, not the viewer nor a member without a name", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "@an");

    expect(optionNames()).toEqual(["u-ann", "u-anders"]);
  });

  it("picks the highlighted member with the arrows and Enter, shows @Name, and sends the token", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "hey @an");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(box().value).toBe("hey @Anders ");
    expect(screen.queryByTestId("bot-mention-list")).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();

    await user.type(box(), "look");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].text).toBe("hey <@u-anders> look");
  });

  describe("two members with the same name", () => {
    const SHARED: BotOwner = {
      kind: "team",
      name: "Acme",
      members: [
        { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
        { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
        { userId: "u-ann-2", displayName: "Ann Lee", avatarUrl: null },
      ],
    };

    async function sentText(user: UserEvent): Promise<string> {
      await user.click(screen.getByTestId("bot-channel-composer-send"));
      return mocks.send.mock.calls.at(-1)?.[0].text ?? "";
    }

    it("sends the one picked from the list", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{Enter}");
      expect(box().value).toBe("@Ann Lee ");

      expect(await sentText(user)).toBe("<@u-ann>");
    });

    it("sends the second member when the second was picked", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");

      expect(await sentText(user)).toBe("<@u-ann-2>");
    });

    it("forgets the picks of a box that was emptied", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      await user.clear(box());

      await user.type(box(), "@ann");
      await user.keyboard("{Enter}");

      expect(await sentText(user)).toBe("<@u-ann>");
    });

    it("keeps each pick's member when a mention is inserted before an earlier pick", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      expect(box().value).toBe("@Ann Lee ");

      await user.keyboard("{Home}@ann{Enter}");

      expect(box().value).toBe("@Ann Lee @Ann Lee ");
      expect(await sentText(user)).toBe("<@u-ann> <@u-ann-2>");
    });

    it("keeps the second recipient when the first edited mention is deleted", async () => {
      const user = userEvent.setup();
      render(
        <BotIdentityContext
          value={{ botId: "bot-1", title: "Tracy", owner: SHARED }}
        >
          {composer({
            requestId: "request-failed",
            text: "hi <@u-ann> and <@u-ann-2>",
          })}
        </BotIdentityContext>,
      );
      expect(box().value).toBe("hi @Ann Lee and @Ann Lee");
      await user.click(box());
      act(() => box().setSelectionRange(3, 16));

      await user.keyboard("{Backspace}");

      expect(box().value).toBe("hi @Ann Lee");
      expect(await sentText(user)).toBe("hi <@u-ann-2>");
    });

    it("does not turn a later plain shared name into a mention once its pick is deleted", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "hello @ann");
      await user.keyboard("{ArrowDown}{Enter}");
      expect(box().value).toBe("hello @Ann Lee ");
      act(() => box().setSelectionRange(6, 15));

      await user.keyboard("{Backspace}");
      expect(box().value).toBe("hello ");
      await user.type(box(), "plain @Ann Lee");

      expect(await sentText(user)).toBe("hello plain @Ann Lee");
    });

    it("sends a shared name retyped over a picked mention as typed, not as the member picked", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      expect(box().value).toBe("@Ann Lee ");
      act(() => box().setSelectionRange(0, 8));

      await user.keyboard("@Ann Lee");

      expect(box().value).toBe("@Ann Lee ");
      expect(await sentText(user)).toBe("@Ann Lee");
    });

    it("sends a unique member's name typed plainly, with no pick, as their token", async () => {
      const user = userEvent.setup();
      mountIn(TEAM);
      await user.type(box(), "hi @Bob");

      await user.click(screen.getByTestId("bot-channel-composer-send"));

      expect(mocks.send.mock.calls.at(-1)?.[0].text).toBe("hi <@u-bob>");
    });

    it("sends an edited message's mention to the member it named", async () => {
      const user = userEvent.setup();
      render(
        <BotIdentityContext
          value={{ botId: "bot-1", title: "Tracy", owner: SHARED }}
        >
          {composer({ requestId: "request-failed", text: "hi <@u-ann-2>" })}
        </BotIdentityContext>,
      );
      expect(box().value).toBe("hi @Ann Lee");

      expect(await sentText(user)).toBe("hi <@u-ann-2>");
    });
  });

  it("closes the list on Escape and keeps the text", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "@an");
    expect(screen.getByTestId("bot-mention-list")).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("bot-mention-list")).toBeNull();
    expect(box().value).toBe("@an");
  });

  it("shows no list for a personal bot, and sends the @ as typed", async () => {
    const user = userEvent.setup();
    mountIn(PERSON);

    await user.type(box(), "@an");
    expect(screen.queryByTestId("bot-mention-list")).toBeNull();

    await user.click(screen.getByTestId("bot-channel-composer-send"));
    expect(mocks.send.mock.calls[0][0].text).toBe("@an");
  });
});
