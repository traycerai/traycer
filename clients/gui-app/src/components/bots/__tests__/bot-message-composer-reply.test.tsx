/**
 * The bot message box replying to a message a member chose (Tracy Bots T166),
 * through the REAL `BotMessageComposer` over the real kept draft
 * (`useKeptBoxDraft`): the strip at the top of the box naming the message, its
 * cancel, and what the send carries. The send mutation is scripted, and a case
 * settles it as the host's refusal would land.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import type { BotReplyTarget } from "@/lib/bots/bot-reply-target";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  boxInput,
  boxText,
  findBoxInput,
  typeKeys,
} from "@/components/bots/__tests__/bot-box-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";

const mocks = vi.hoisted(() => ({
  /** Every request the box sent, in order. */
  sent: [] as BotConversationSendRequest[],
  /** Each send's answer, held until a case settles it. */
  answers: [] as PromiseWithResolvers<BotConversationSendResponse>[],
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutateAsync: (variables: BotConversationSendRequest) => {
      const answer = Promise.withResolvers<BotConversationSendResponse>();
      mocks.sent.push(variables);
      mocks.answers.push(answer);
      return answer.promise;
    },
    isPending: false,
  }),
}));

import {
  BotIdentityContext,
  type BotOwner,
} from "@/components/bots/bot-identity-context";
import {
  BotMessageComposer,
  type BotComposerEdit,
  type BotComposerReply,
} from "@/components/bots/bot-message-composer";

const BOT = "bot-1";
const CONVERSATION = "conversation-channel";
const LABEL = "Message Tracy";
const STRIP = "bot-channel-composer-reply";

const TARGET: BotReplyTarget = {
  messageId: "post-9",
  author: "Tess Teammate",
  line: "Please review the release",
};

const DELIVERED: BotComposerReply = { reach: "delivered", chosen: 0 };

/** A team whose members the `@` menu offers. */
const TEAM: BotOwner = {
  kind: "team",
  name: "Acme",
  members: [
    { userId: "u-viewer", displayName: "Andy Viewer", avatarUrl: null },
    { userId: "u-ann", displayName: "Ann Lee", avatarUrl: null },
  ],
};

const FAILED_EDIT: BotComposerEdit = {
  requestId: "request-failed",
  text: "Is CI green?",
  content: null,
};

/** The box with its owner's real failure line and kept draft. */
function Harness(props: {
  readonly reply: BotComposerReply;
  readonly edit: BotComposerEdit | null;
}): ReactNode {
  const failure = useBotSendFailure();
  const kept = useKeptBoxDraft(BOT, CONVERSATION);
  return (
    <BotIdentityContext value={{ botId: BOT, title: "Tracy", owner: TEAM }}>
      <BotTestRunnerHost>
        <BotMessageComposer
          botId={BOT}
          botTitle="Tracy"
          conversationId={CONVERSATION}
          threadId={null}
          announcementId={null}
          sendable
          imageReach="none"
          placeholder={LABEL}
          label={LABEL}
          testId="bot-channel-composer"
          failure={failure}
          edit={props.edit}
          onEditEnd={() => undefined}
          onEditResume={() => undefined}
          seed={kept.seed}
          keptDraft={kept.keptDraft}
          quote={null}
          reply={props.reply}
          onSent={() => false}
        />
      </BotTestRunnerHost>
    </BotIdentityContext>
  );
}

/** Names `target` in the box, as Reply on a row of the conversation does. */
function chooseReply(target: BotReplyTarget): void {
  act(() => {
    useBotDraftsStore.getState().setReplyTarget(BOT, CONVERSATION, target);
  });
}

/** Types into the box once its editor is up; `{Key}` presses a key. */
async function typeBox(sequence: string): Promise<void> {
  await findBoxInput(LABEL);
  typeKeys(LABEL, sequence);
}

/** The request the box sent last. */
function lastRequest(): BotConversationSendRequest {
  const request = mocks.sent.at(-1);
  if (request === undefined) throw new Error("the box sent nothing");
  return request;
}

/** The host refusing the send the box made last, and the box taking the outcome. */
async function refuseLastSend(): Promise<void> {
  const answer = mocks.answers.at(-1);
  if (answer === undefined) throw new Error("the box sent nothing");
  await act(async () => {
    answer.reject(new Error("host refused the post"));
    await answer.promise.catch(() => undefined);
  });
}

afterEach(() => {
  cleanup();
  mocks.sent = [];
  mocks.answers = [];
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
});

describe("<BotMessageComposer /> the message it replies to", () => {
  it("names the message's writer and the line it was chosen with in a strip, with no note where the host takes replies", () => {
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);

    const strip = screen.getByTestId(STRIP);
    expect(strip.textContent).toContain("Replying to");
    expect(screen.getByTestId(`${STRIP}-author`).textContent).toBe(
      "Tess Teammate",
    );
    expect(screen.getByTestId(`${STRIP}-line`).textContent).toBe(
      "Please review the release",
    );
    expect(screen.queryByTestId(`${STRIP}-held-back`)).toBeNull();
  });

  it("takes the strip away from Cancel reply, and the caret back to the box", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);
    await findBoxInput(LABEL);

    await user.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(screen.queryByTestId(STRIP)).toBeNull();
    expect(document.activeElement).toBe(boxInput(LABEL));
  });

  it("takes the strip away from Escape in the box", async () => {
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);

    await typeBox("{Escape}");

    expect(screen.queryByTestId(STRIP)).toBeNull();
  });

  it("takes the focus to the box each time Reply is chosen again", async () => {
    const view = render(<Harness reply={DELIVERED} edit={null} />);
    const input = await findBoxInput(LABEL);
    expect(document.activeElement).not.toBe(input);

    view.rerender(
      <Harness reply={{ reach: "delivered", chosen: 1 }} edit={null} />,
    );
    expect(document.activeElement).toBe(input);

    act(() => input.blur());
    view.rerender(
      <Harness reply={{ reach: "delivered", chosen: 2 }} edit={null} />,
    );
    expect(document.activeElement).toBe(input);
  });
});

describe("<BotMessageComposer /> Escape with an @ menu open", () => {
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

  it("closes the menu and keeps the strip", async () => {
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);
    await typeBox("@");
    expect(
      document.querySelector('[data-slot="composer-menu"]'),
    ).not.toBeNull();

    await typeBox("{Escape}");

    expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull();
    expect(screen.getByTestId(STRIP)).toBeTruthy();
  });
});

describe("<BotMessageComposer /> sending a reply", () => {
  it("sends the message's id as replyTo where the host takes replies, and drops the strip at the send", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);
    await typeBox("Looks good");

    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(lastRequest()).toEqual({
      botId: BOT,
      conversationId: CONVERSATION,
      text: "Looks good",
      threadId: null,
      announcementId: null,
      redeliver: null,
      supersedes: null,
      answer: null,
      replyTo: "post-9",
    });
    expect(screen.queryByTestId(STRIP)).toBeNull();
    expect(
      useBotDraftsStore.getState().threadBoxes[BOT]?.[CONVERSATION],
    ).toBeUndefined();
  });

  it("says the host can't take replies yet, and sends the message without replyTo", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    render(<Harness reply={{ reach: "held-back", chosen: 0 }} edit={null} />);
    expect(screen.getByTestId(`${STRIP}-held-back`).textContent).toBe(
      "This bot's host can't take replies yet, so this will be sent as a new message.",
    );
    await typeBox("Looks good");

    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(lastRequest().text).toBe("Looks good");
    expect(Object.hasOwn(lastRequest(), "replyTo")).toBe(false);
  });

  it("shows no strip where the host takes no reply, and sends without replyTo", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    render(<Harness reply={{ reach: "none", chosen: 0 }} edit={null} />);
    await typeBox("Looks good");

    expect(screen.queryByTestId(STRIP)).toBeNull();
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(Object.hasOwn(lastRequest(), "replyTo")).toBe(false);
  });

  it("shows no strip while the box edits a failed message, whose send replaces it and replies to nothing, and shows it again once the edit is over", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    const view = render(<Harness reply={DELIVERED} edit={null} />);
    expect(screen.getByTestId(STRIP)).toBeTruthy();

    view.rerender(<Harness reply={DELIVERED} edit={FAILED_EDIT} />);
    expect(screen.queryByTestId(STRIP)).toBeNull();
    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(lastRequest().supersedes).toBe("request-failed");
    expect(Object.hasOwn(lastRequest(), "replyTo")).toBe(false);
    view.rerender(<Harness reply={DELIVERED} edit={null} />);
    expect(screen.getByTestId(`${STRIP}-line`).textContent).toBe(
      "Please review the release",
    );
  });

  it("keeps the edit's text in a box that mounts with an edit while its kept draft holds only the message it replies to, and sends it as the replacement", async () => {
    const user = userEvent.setup();
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={FAILED_EDIT} />);
    await findBoxInput(LABEL);
    expect(boxText(LABEL)).toBe("Is CI green?");

    await user.click(screen.getByTestId("bot-channel-composer-send"));

    expect(lastRequest().text).toBe("Is CI green?");
    expect(lastRequest().supersedes).toBe("request-failed");
    expect(Object.hasOwn(lastRequest(), "replyTo")).toBe(false);
  });

  it("puts the text and the strip back in the box when the host refuses the send", async () => {
    chooseReply(TARGET);
    render(<Harness reply={DELIVERED} edit={null} />);
    await typeBox("Looks good{Enter}");
    expect(boxText(LABEL)).toBe("");
    expect(screen.queryByTestId(STRIP)).toBeNull();

    await refuseLastSend();

    expect(boxText(LABEL)).toBe("Looks good");
    expect(screen.getByTestId(`${STRIP}-author`).textContent).toBe(
      "Tess Teammate",
    );
    expect(screen.getByTestId(`${STRIP}-line`).textContent).toBe(
      "Please review the release",
    );
  });
});
