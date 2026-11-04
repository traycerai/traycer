/**
 * The bot message box's report of an accepted send (`onSent`), through the
 * REAL `BotMessageComposer`: the send mutation is scripted, and each case
 * answers the send through the callbacks the box handed it, as the host's
 * answer or refusal would land.
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import {
  BotMentionsContext,
  type BotMentionDirectory,
} from "@/components/bots/bot-mentions-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  BotMessageComposer,
  type BotComposerEdit,
  type BotComposerQuote,
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

function composer(
  edit: BotComposerEdit | null,
  quote: BotComposerQuote | null,
): ReactNode {
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
      quote={quote}
      onSent={onSent}
    />
  );
}

function box(): HTMLTextAreaElement {
  const element = screen.getByRole("textbox", { name: "Message Tracy" });
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("no box");
  return element;
}

/** The `@` menu, which portals to the body; `null` while it is closed. */
function mentionMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="composer-menu"]');
}

function openMenu(): HTMLElement {
  const menu = mentionMenu();
  if (menu === null) throw new Error("the mention menu is not open");
  return menu;
}

/** A menu row's name: its label, without the avatar or description beside it. */
function rowLabel(row: HTMLElement): string {
  return row.querySelector("span.font-medium")?.textContent ?? "";
}

function menuRows(): HTMLElement[] {
  return Array.from(
    openMenu().querySelectorAll<HTMLElement>('[role="option"]'),
  );
}

/** The menu's rows in order, by name. */
function menuLabels(): string[] {
  return menuRows().map(rowLabel);
}

function menuRow(label: string): HTMLElement {
  const row = menuRows().find((candidate) => rowLabel(candidate) === label);
  if (row === undefined) throw new Error(`no menu row ${label}`);
  return row;
}

/** The menu's header: "Mentions" at the first level, else the category. */
function menuHeader(): string {
  return openMenu().firstElementChild?.textContent ?? "";
}

/** The name of the row the menu highlights. */
function highlightedLabel(): string | null {
  const row = menuRows().find(
    (candidate) => candidate.getAttribute("aria-selected") === "true",
  );
  return row === undefined ? null : rowLabel(row);
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
    render(composer(null, null));
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
    render(composer(null, null));
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
    render(composer(null, null));
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
    render(
      composer({ requestId: "request-failed", text: "Is CI green?" }, null),
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );

    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
  });

  it("reports an edit's send the person moved on from, and keeps the edit they opened since", async () => {
    const user = userEvent.setup();
    const view = render(
      composer({ requestId: "request-first", text: "Is CI green?" }, null),
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    const callbacks = lastSend();
    view.rerender(
      composer(
        { requestId: "request-second", text: "Is the nightly green?" },
        null,
      ),
    );

    await settleSend(callbacks, (sent) => sent.onSuccess?.(RESPONSE));

    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
    expect(onEditEnd).not.toHaveBeenCalled();
    expect(box().value).toBe("Is the nightly green?");
  });
});

describe("<BotMessageComposer /> quoting", () => {
  it("keeps a quote added while a send is in flight when the send lands, and reports the send", async () => {
    const user = userEvent.setup();
    const view = render(composer(null, null));
    await user.type(box(), "Is CI green?");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    const callbacks = lastSend();

    view.rerender(
      composer(null, {
        id: 1,
        snapshots: [{ text: "quoted", fenceLanguage: null }],
        taken: vi.fn(),
      }),
    );
    expect(box().value).toBe("Is CI green?\n\n> quoted\n\n");
    await settleSend(callbacks, (sent) => sent.onSuccess?.(RESPONSE));

    expect(box().value).toBe("Is CI green?\n\n> quoted\n\n");
    expect(onSent).toHaveBeenCalledWith(RESPONSE, "Is CI green?");
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
        {composer(null, null)}
      </BotIdentityContext>,
    );
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

  it("lists the team's matching members in one flat list, not the viewer nor a member without a name", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "@an");

    // The composer's root ranking: the shorter name that starts with it first.
    expect(menuLabels()).toEqual(["Anders", "Ann Lee"]);
  });

  it("picks the highlighted member with the arrows and Enter, shows @Name, and sends the token", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "hey @an");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(box().value).toBe("hey @Ann Lee ");
    expect(mentionMenu()).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();

    await user.type(box(), "look");
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].text).toBe("hey <@u-ann> look");
  });

  describe("two members with the same name", () => {
    const SHARED_MEMBERS = [
      { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
      { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
      { userId: "u-ann-2", displayName: "Ann Lee", avatarUrl: null },
    ];
    const SHARED: BotOwner = {
      kind: "team",
      name: "Acme",
      members: SHARED_MEMBERS,
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
          {composer(
            {
              requestId: "request-failed",
              text: "hi <@u-ann> and <@u-ann-2>",
            },
            null,
          )}
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

    function mountEdit(text: string): void {
      render(
        <BotIdentityContext
          value={{ botId: "bot-1", title: "Tracy", owner: SHARED }}
        >
          {composer({ requestId: "request-failed", text }, null)}
        </BotIdentityContext>,
      );
    }

    it("keeps the first recipient when the second of two identical mentions is deleted", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> <@u-ann-2> ");
      expect(box().value).toBe("@Ann Lee @Ann Lee ");
      await user.click(box());
      act(() => box().setSelectionRange(9, 18));

      await user.keyboard("{Backspace}");

      expect(box().value).toBe("@Ann Lee ");
      expect(await sentText(user)).toBe("<@u-ann>");
    });

    it("does not give text pasted over two mentions the identity of an old one", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> <@u-ann-2> <@u-ann>");
      await user.click(box());
      act(() => box().setSelectionRange(0, 18));

      await user.paste("@Ann Lee ");

      expect(box().value).toBe("@Ann Lee @Ann Lee");
      expect(await sentText(user)).toBe("@Ann Lee <@u-ann>");
    });

    it("sends a shared full name as typed rather than as a shorter unique name and a word", async () => {
      const user = userEvent.setup();
      mountIn({
        ...SHARED,
        members: [
          ...SHARED_MEMBERS,
          { userId: "u-short", displayName: "Ann", avatarUrl: null },
        ],
      });
      await user.type(box(), "hi @Ann Lee");

      expect(await sentText(user)).toBe("hi @Ann Lee");
    });

    it("keeps a mention's member when a shorter text replaces the words before it", async () => {
      const user = userEvent.setup();
      mountEdit("hello <@u-ann-2> tail");
      await user.click(box());
      act(() => box().setSelectionRange(0, 5));

      fireEvent.compositionStart(box());
      fireEvent.input(box(), {
        target: { value: "你好 @Ann Lee tail" },
        data: "你好",
        inputType: "insertCompositionText",
        isComposing: true,
      });
      fireEvent.compositionEnd(box(), { data: "你好" });

      expect(await sentText(user)).toBe("你好 <@u-ann-2> tail");
    });

    it("keeps a mention that an undo leaves textually intact with its member", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      await user.keyboard("later");
      expect(box().value).toBe("@Ann Lee later");

      // jsdom has no undo: the box is set back to the value it held before.
      fireEvent.input(box(), { target: { value: "@Ann Lee " } });

      expect(box().value).toBe("@Ann Lee ");
      expect(await sentText(user)).toBe("<@u-ann-2>");
    });

    it("sends as typed a shared name an undo restores after its mention was deleted", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      act(() => box().setSelectionRange(0, 8));
      await user.keyboard("{Backspace}");
      expect(box().value).toBe(" ");

      fireEvent.input(box(), { target: { value: "@Ann Lee " } });

      expect(box().value).toBe("@Ann Lee ");
      expect(await sentText(user)).toBe("@Ann Lee");
    });

    it("keeps the mention an undo restores after the caret moved, by what the text says, not by where the caret was", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> <@u-ann-2> ");
      await user.click(box());
      act(() => box().setSelectionRange(0, 9));
      await user.keyboard("{Backspace}{ArrowRight>9/}");
      expect(box().value).toBe("@Ann Lee ");
      expect(box().selectionStart).toBe(9);

      box().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "historyUndo",
        }),
      );
      fireEvent.input(box(), {
        target: {
          value: "@Ann Lee @Ann Lee ",
          selectionStart: 0,
          selectionEnd: 9,
        },
        inputType: "historyUndo",
      });

      expect(await sentText(user)).toBe("@Ann Lee <@u-ann-2>");
    });

    it("does not bind text replacing a selection to the pick the selection had moved away from", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> <@u-ann-2> ");
      await user.click(box());
      act(() => box().setSelectionRange(0, 9));
      fireEvent.select(box());

      act(() => {
        box().setSelectionRange(9, 18);
        box().dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertReplacementText",
            data: "@Ann Lee @Ann Lee ",
          }),
        );
        fireEvent.input(box(), {
          target: {
            value: "@Ann Lee @Ann Lee @Ann Lee ",
            selectionStart: 27,
            selectionEnd: 27,
          },
          inputType: "insertReplacementText",
          data: "@Ann Lee @Ann Lee ",
        });
      });

      expect(await sentText(user)).toBe("<@u-ann> @Ann Lee @Ann Lee");
    });

    it("drops a mention a spelling correction changes part of, and sends the corrected text as typed", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{Enter}");
      expect(box().value).toBe("@Ann Lee ");
      act(() => box().setSelectionRange(5, 8));

      act(() => {
        box().dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertReplacementText",
            data: "Leo",
          }),
        );
        fireEvent.input(box(), {
          target: { value: "@Ann Leo ", selectionStart: 8, selectionEnd: 8 },
          inputType: "insertReplacementText",
          data: "Leo",
        });
      });

      expect(box().value).toBe("@Ann Leo ");
      expect(await sentText(user)).toBe("@Ann Leo");
    });

    /** One input event, as a browser makes it: `beforeinput`, then `input`. */
    function inputEvent(
      value: string,
      selection: { start: number; end: number },
      inputType: string,
    ): void {
      act(() => {
        box().dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType,
            data: null,
          }),
        );
        fireEvent.input(box(), {
          target: {
            value,
            selectionStart: selection.start,
            selectionEnd: selection.end,
          },
          inputType,
          data: null,
        });
      });
    }

    it("keeps the first recipient when the deletion of the second mention is undone", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> <@u-ann-2> ");
      await user.click(box());
      act(() => box().setSelectionRange(9, 18));
      await user.keyboard("{Backspace}");
      expect(box().value).toBe("@Ann Lee ");

      inputEvent("@Ann Lee @Ann Lee ", { start: 9, end: 18 }, "historyUndo");

      expect(box().value).toBe("@Ann Lee @Ann Lee ");
      expect(await sentText(user)).toBe("<@u-ann> @Ann Lee");
    });

    it("drops a picked shared name that a paste over the whole text replaced, though the new text repeats it", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> ok");
      await user.click(box());
      act(() => box().setSelectionRange(0, 11));

      await user.paste("@Ann Lee OK");

      expect(box().value).toBe("@Ann Lee OK");
      expect(await sentText(user)).toBe("@Ann Lee OK");
    });

    it("drops a picked shared name that a paste of the identical text replaced", async () => {
      const user = userEvent.setup();
      mountEdit("<@u-ann> ok");
      await user.click(box());
      act(() => box().setSelectionRange(0, 11));
      const received: string[] = [];
      for (const type of ["beforeinput", "input"]) {
        box().addEventListener(type, (event) => received.push(event.type));
      }

      await user.paste("@Ann Lee ok");

      expect(received).toEqual(["beforeinput", "input"]);
      expect(box().value).toBe("@Ann Lee ok");
      expect(await sentText(user)).toBe("@Ann Lee ok");
    });

    it("keeps a mention's member when the typing after it is undone, with the caret at its end", async () => {
      const user = userEvent.setup();
      mountIn(SHARED);
      await user.type(box(), "@ann");
      await user.keyboard("{ArrowDown}{Enter}");
      await user.keyboard("later");
      expect(box().value).toBe("@Ann Lee later");

      inputEvent("@Ann Lee ", { start: 9, end: 9 }, "historyUndo");

      expect(box().value).toBe("@Ann Lee ");
      expect(await sentText(user)).toBe("<@u-ann-2>");
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
          {composer(
            { requestId: "request-failed", text: "hi <@u-ann-2>" },
            null,
          )}
        </BotIdentityContext>,
      );
      expect(box().value).toBe("hi @Ann Lee");

      expect(await sentText(user)).toBe("hi <@u-ann-2>");
    });
  });

  it("closes the menu on Escape and keeps the text", async () => {
    const user = userEvent.setup();
    mountIn(TEAM);

    await user.type(box(), "@an");
    expect(mentionMenu()).not.toBeNull();
    await user.keyboard("{Escape}");

    expect(mentionMenu()).toBeNull();
    expect(box().value).toBe("@an");
  });

  it("shows no menu for a personal bot with nothing to name, and sends the @ as typed", async () => {
    const user = userEvent.setup();
    mountIn(PERSON);

    await user.type(box(), "@an");
    expect(mentionMenu()).toBeNull();

    await user.click(screen.getByTestId("bot-channel-composer-send"));
    expect(mocks.send.mock.calls[0][0].text).toBe("@an");
  });
});

describe("<BotMessageComposer /> @ mentions of bots and tasks", () => {
  const OWN_BOT = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0";
  const TRIAGE_BOT = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1";
  const NOTES_BOT = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M2";
  const RELEASE_TASK = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const ROADMAP_TASK = "0b9d7c1e-2a3f-4b5c-8d6e-7f8091a2b3c4";
  const TEAM: BotOwner = {
    kind: "team",
    name: "Acme",
    members: [
      { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
      { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
      { userId: "u-anon", displayName: null, avatarUrl: null },
    ],
  };
  const PERSON: BotOwner = {
    kind: "person",
    userId: "u-viewer",
    name: "Andy Viewer",
    avatarUrl: null,
  };
  const DIRECTORY: BotMentionDirectory = {
    person: () => null,
    bots: [
      { id: OWN_BOT, name: "Tracy" },
      { id: TRIAGE_BOT, name: "Triage" },
      { id: NOTES_BOT, name: "Release bot" },
    ],
    tasks: [
      { id: RELEASE_TASK, name: "Release notes" },
      { id: ROADMAP_TASK, name: "Roadmap" },
    ],
  };

  function mountWith(
    owner: BotOwner,
    directory: BotMentionDirectory,
    edit: BotComposerEdit | null,
  ): void {
    render(
      <BotIdentityContext value={{ botId: OWN_BOT, title: "Tracy", owner }}>
        <BotMentionsContext value={directory}>
          {composer(edit, null)}
        </BotMentionsContext>
      </BotIdentityContext>,
    );
  }

  async function sentText(user: UserEvent): Promise<string> {
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    return mocks.send.mock.calls.at(-1)?.[0].text ?? "";
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

  it("shows People, Bots and Tasks after @ for a team bot, and nothing else", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);

    await user.type(box(), "@");

    expect(menuLabels()).toEqual(["People", "Bots", "Tasks"]);
    expect(menuHeader()).toBe("Mentions");
  });

  it("shows Bots and Tasks after @ for a personal bot, which has no one else to name", async () => {
    const user = userEvent.setup();
    mountWith(PERSON, DIRECTORY, null);

    await user.type(box(), "@");

    expect(menuLabels()).toEqual(["Bots", "Tasks"]);
  });

  it("opens the Bots step on a click: Back first, then the environment's bots without the box's own, under the header Bots", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");

    await user.click(menuRow("Bots"));

    expect(menuHeader()).toBe("Bots");
    expect(menuLabels()).toEqual(["Back", "Triage", "Release bot"]);
  });

  it("opens the Bots step on Enter at the highlighted row, with the same rows", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(menuHeader()).toBe("Bots");
    expect(menuLabels()).toEqual(["Back", "Triage", "Release bot"]);
    expect(box().value).toBe("@");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("returns from a step to the three categories on Back", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");
    await user.click(menuRow("Bots"));

    await user.click(menuRow("Back"));

    expect(menuHeader()).toBe("Mentions");
    expect(menuLabels()).toEqual(["People", "Bots", "Tasks"]);
  });

  it("ranks what is typed after @ in one flat list across kinds, a prefix hit before a substring hit whatever its kind, with no category rows", async () => {
    const user = userEvent.setup();
    mountWith(
      TEAM,
      {
        person: () => null,
        bots: [
          { id: OWN_BOT, name: "Tracy" },
          { id: NOTES_BOT, name: "Weekly roadmap" },
        ],
        tasks: [{ id: ROADMAP_TASK, name: "Roadmap" }],
      },
      null,
    );

    await user.type(box(), "@road");

    // The bot comes first in the categories' order; the task's name starts
    // with the query and the bot's only has it in the middle.
    expect(menuLabels()).toEqual(["Roadmap", "Weekly roadmap"]);
    expect(menuHeader()).toBe("Mentions");
  });

  it.each([
    {
      category: "People",
      name: "Ann Lee",
      written: "@Ann Lee ",
      token: "<@u-ann>",
    },
    {
      category: "Bots",
      name: "Triage",
      written: "@Triage ",
      token: `<#${TRIAGE_BOT}>`,
    },
    {
      category: "Tasks",
      name: "Release notes",
      written: "@Release notes ",
      token: `<~${RELEASE_TASK}>`,
    },
  ])(
    "writes @Name for a pick from the $category step and sends its token",
    async ({ category, name, written, token }) => {
      const user = userEvent.setup();
      mountWith(TEAM, DIRECTORY, null);
      await user.type(box(), "@");
      await user.click(menuRow(category));

      await user.click(menuRow(name));

      expect(box().value).toBe(written);
      expect(mentionMenu()).toBeNull();
      expect(await sentText(user)).toBe(token);
    },
  );

  it("walks to Tasks with the arrows, wraps from its Back row to the last name, and Enter picks it without sending the message", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(highlightedLabel()).toBe("Tasks");
    await user.keyboard("{Enter}");
    expect(menuHeader()).toBe("Tasks");
    expect(mocks.send).not.toHaveBeenCalled();

    await user.keyboard("{ArrowUp}");
    expect(highlightedLabel()).toBe("Roadmap");
    await user.keyboard("{Enter}");

    expect(box().value).toBe("@Roadmap ");
    expect(mentionMenu()).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("wraps the highlight from the last category to the first on ArrowDown", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");

    expect(highlightedLabel()).toBe("People");
  });

  it("does not take Shift+Enter: the box gets its new line and the menu picks nothing", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    await user.type(box(), "@");

    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(box().value).toBe("@\n");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("closes the menu when what is typed matches no name, when a comma ends the query, and on a double space", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);

    await user.type(box(), "@zzzz");
    expect(mentionMenu()).toBeNull();

    await user.clear(box());
    await user.type(box(), "@Road");
    expect(mentionMenu()).not.toBeNull();
    await user.keyboard(",");
    expect(mentionMenu()).toBeNull();

    // Still a name's start once trimmed: only the prose rule closes it.
    await user.clear(box());
    await user.type(box(), "@Road  ");
    expect(mentionMenu()).toBeNull();
  });

  it("keeps each row's kind glyph in a category step: a person's avatar, a bot's avatar, the task icon", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);
    const glyphsOf = (row: HTMLElement): string[] =>
      [
        ["person-avatar", "person"],
        ["bot-avatar", "bot"],
        ["bot-mention-task-glyph", "task"],
      ].flatMap(([testId, kind]) =>
        row.querySelector(`[data-testid="${testId}"]`) === null ? [] : [kind],
      );

    await user.type(box(), "@");
    await user.click(menuRow("People"));
    expect(glyphsOf(menuRow("Ann Lee"))).toEqual(["person"]);

    await user.click(menuRow("Back"));
    await user.click(menuRow("Bots"));
    expect(glyphsOf(menuRow("Triage"))).toEqual(["bot"]);

    await user.click(menuRow("Back"));
    await user.click(menuRow("Tasks"));
    expect(glyphsOf(menuRow("Release notes"))).toEqual(["task"]);
  });

  it("shows @Name for a pick of each kind and sends each as its own token", async () => {
    const user = userEvent.setup();
    mountWith(TEAM, DIRECTORY, null);

    await user.type(box(), "ask @ann");
    await user.keyboard("{Enter}");
    await user.type(box(), "@tri");
    await user.keyboard("{Enter}");
    await user.type(box(), "about @notes");
    await user.keyboard("{Enter}");

    expect(box().value).toBe("ask @Ann Lee @Triage about @Release notes ");
    expect(await sentText(user)).toBe(
      `ask <@u-ann> <#${TRIAGE_BOT}> about <~${RELEASE_TASK}>`,
    );
  });

  it("sends a bot's or a task's name typed plainly as its token, and an @ naming neither as typed", async () => {
    const user = userEvent.setup();
    mountWith(PERSON, DIRECTORY, null);
    await user.type(box(), "@Triage see @Release notes and @nobody");

    expect(await sentText(user)).toBe(
      `<#${TRIAGE_BOT}> see <~${RELEASE_TASK}> and @nobody`,
    );
  });

  describe("a bot and a task with the same name", () => {
    const SHARED: BotMentionDirectory = {
      person: () => null,
      bots: [
        { id: OWN_BOT, name: "Tracy" },
        { id: TRIAGE_BOT, name: "Roadmap" },
      ],
      tasks: [{ id: ROADMAP_TASK, name: "Roadmap" }],
    };

    it("sends the one picked", async () => {
      const user = userEvent.setup();
      mountWith(PERSON, SHARED, null);
      await user.type(box(), "@road");
      await user.keyboard("{ArrowDown}{Enter}");

      expect(await sentText(user)).toBe(`<~${ROADMAP_TASK}>`);
    });

    it("sends the name as typed when none was picked", async () => {
      const user = userEvent.setup();
      mountWith(PERSON, SHARED, null);
      await user.type(box(), "@Roadmap");

      expect(await sentText(user)).toBe("@Roadmap");
    });
  });

  it("shows an edited message's three tokens as names and sends them back as the same tokens", async () => {
    const user = userEvent.setup();
    const wire = `<@u-ann> asked <#${TRIAGE_BOT}> about <~${RELEASE_TASK}>`;
    mountWith(TEAM, DIRECTORY, { requestId: "request-failed", text: wire });

    expect(box().value).toBe("@Ann Lee asked @Triage about @Release notes");
    expect(await sentText(user)).toBe(wire);
  });

  it("shows an edited message's token that nothing names as it was written", async () => {
    const user = userEvent.setup();
    const gone = `<#${NOTES_BOT}> and <~${ROADMAP_TASK}>`;
    mountWith(
      PERSON,
      { person: () => null, bots: [], tasks: [] },
      { requestId: "request-failed", text: gone },
    );

    expect(box().value).toBe(gone);
    expect(await sentText(user)).toBe(gone);
  });
});

describe("the mention menu after Escape", () => {
  const TEAM: BotOwner = {
    kind: "team",
    name: "Acme",
    members: [
      { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
      { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
      { userId: "u-anders", displayName: "Anders", avatarUrl: null },
      { userId: "u-bob", displayName: "Bob", avatarUrl: null },
    ],
  };

  beforeEach(() => {
    useAuthStore.setState({
      profile: {
        userId: "u-viewer",
        userName: "Andy Viewer",
        email: "andy@example.com",
        avatarUrl: null,
      },
    });
    render(
      <BotIdentityContext
        value={{ botId: "bot-1", title: "Tracy", owner: TEAM }}
      >
        {composer(null, null)}
      </BotIdentityContext>,
    );
  });

  afterEach(() => {
    useAuthStore.setState({ profile: null });
  });

  it("shows again for an @ at the same offset once the box was cleared", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");
    await user.keyboard("{Escape}");
    expect(mentionMenu()).toBeNull();

    await user.clear(box());
    await user.type(box(), "@an");

    expect(mentionMenu()).not.toBeNull();
  });

  it("shows again for an @ at the same offset after a send", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );
    expect(box().value).toBe("");

    await user.type(box(), "@an");

    expect(mentionMenu()).not.toBeNull();
  });

  it("shows for a new @ at the offset it was closed on, after a pick at another @", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");
    await user.keyboard("{Escape}");
    await user.type(box(), " @bo");
    await user.keyboard("{Enter}");
    expect(box().value).toBe("@an @Bob ");
    expect(mentionMenu()).toBeNull();

    act(() => box().setSelectionRange(0, 3));
    await user.keyboard("@an");

    expect(mentionMenu()).not.toBeNull();
  });

  it("stays closed while the same @ is still being typed", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@a");
    await user.keyboard("{Escape}");
    await user.keyboard("n");

    expect(box().value).toBe("@an");
    expect(mentionMenu()).toBeNull();
  });
});

describe("the mention menu's highlight and attributes", () => {
  const TEAM: BotOwner = {
    kind: "team",
    name: "Acme",
    members: [
      { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
      { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
      { userId: "u-anders", displayName: "Anders", avatarUrl: null },
    ],
  };

  beforeEach(() => {
    useAuthStore.setState({
      profile: {
        userId: "u-viewer",
        userName: "Andy Viewer",
        email: "andy@example.com",
        avatarUrl: null,
      },
    });
    render(
      <BotIdentityContext
        value={{ botId: "bot-1", title: "Tracy", owner: TEAM }}
      >
        {composer(null, null)}
      </BotIdentityContext>,
    );
  });

  afterEach(() => {
    useAuthStore.setState({ profile: null });
  });

  it("marks the first row aria-selected when it opens, and only that row", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");

    expect(highlightedLabel()).toBe("Anders");
    expect(
      openMenu().querySelectorAll('[role="option"][aria-selected="true"]'),
    ).toHaveLength(1);
  });

  it("moves the aria-selected row with the arrows", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");

    await user.keyboard("{ArrowDown}");

    expect(highlightedLabel()).toBe("Ann Lee");
  });

  it("moves the highlight to the row the pointer is over", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");

    await user.hover(menuRow("Ann Lee"));

    expect(highlightedLabel()).toBe("Ann Lee");
  });

  it("carries only attributes a multiline box allows, with valid values, while the menu shows", async () => {
    const user = userEvent.setup();
    await user.type(box(), "@an");
    const { default: axe } = await import("axe-core");

    const result = await axe.run(document.body, {
      runOnly: {
        type: "rule",
        values: ["aria-allowed-attr", "aria-valid-attr-value"],
      },
    });

    expect(
      result.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          html: node.html,
          summary: node.failureSummary,
        })),
      })),
    ).toEqual([]);
  });
});
