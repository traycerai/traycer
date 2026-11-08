/**
 * The bot message box and its kept draft across closing it and restarting the
 * app (Tracy Bots T158): the REAL `BotMessageComposer` over the real
 * `useKeptBoxDraft`, drafts store and `localStorage`. Only the send mutation
 * is scripted, and each case settles the send through the callbacks the box
 * handed it.
 */
import { useState, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  boxInput,
  boxText,
  findBoxInput,
  typeKeys,
} from "@/components/bots/__tests__/bot-box-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import {
  BOT_ID,
  MENTION,
  boxDoc,
  pastTheDebounce,
  restartApp,
  startFresh,
  storeDraftsAsLeft,
  storedDrafts,
  waitForStore,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

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
  settled: new WeakMap<SendCallbacks, Promise<void>>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
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

import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";

const LABEL = "Message Tracy";
const CHANNEL = "conversation-channel";
const THREAD = "post-1";
const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

/** The box of one conversation, with the owner's real failure line and kept draft. */
function Box(props: { readonly conversation: string }): ReactNode {
  const failure = useBotSendFailure();
  const kept = useKeptBoxDraft(BOT_ID, props.conversation);
  return (
    <BotTestRunnerHost>
      <BotMessageComposer
        key={props.conversation}
        botId={BOT_ID}
        botTitle="Tracy"
        conversationId={CHANNEL}
        threadId={null}
        announcementId={null}
        sendable
        imageReach="none"
        placeholder={LABEL}
        label={LABEL}
        testId="bot-channel-composer"
        failure={failure}
        edit={null}
        onEditEnd={() => undefined}
        onEditResume={() => undefined}
        seed={kept.seed}
        keptDraft={kept.keptDraft}
        quote={null}
        onSent={() => false}
      />
    </BotTestRunnerHost>
  );
}

/** The channel's box and its thread's, one at a time, as the owner swaps them. */
function Owner(props: { readonly initial: string }): ReactNode {
  const [conversation, setConversation] = useState(props.initial);
  return (
    <BotIdentityContext value={{ botId: BOT_ID, title: "Tracy", owner: null }}>
      <button
        type="button"
        data-testid="switch-conversation"
        onClick={() =>
          setConversation((current) => (current === CHANNEL ? THREAD : CHANNEL))
        }
      >
        Switch
      </button>
      <Box conversation={conversation} />
    </BotIdentityContext>
  );
}

/**
 * The box mounted and its editor found, which polls on the real clock; the
 * fake clock the drafts' write debounce runs on comes after.
 */
async function mountBox(initial: string): Promise<{ unmount: () => void }> {
  vi.useRealTimers();
  const view = render(<Owner initial={initial} />);
  await findBoxInput(LABEL);
  startDebounceClock();
  return view;
}

function startDebounceClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function typeBox(sequence: string): void {
  typeKeys(LABEL, sequence);
}

function lastSend(): SendCallbacks {
  const call = mocks.send.mock.calls.at(-1);
  if (call === undefined) throw new Error("the box sent nothing");
  return call[1];
}

async function settleSend(
  callbacks: SendCallbacks,
  outcome: (callbacks: SendCallbacks) => void,
): Promise<void> {
  await act(async () => {
    outcome(callbacks);
    await mocks.settled.get(callbacks);
  });
}

beforeEach(async () => {
  await startFresh();
});

afterEach(() => {
  cleanup();
  mocks.send.mockReset();
  vi.useRealTimers();
});

describe("<BotMessageComposer /> and its draft on the device", () => {
  it("restores what a conversation's box held when it is mounted again, and shows another conversation's box empty", async () => {
    const first = await mountBox(CHANNEL);
    typeBox("Is CI green?");
    first.unmount();

    await mountBox(CHANNEL);
    expect(boxText(LABEL)).toBe("Is CI green?");

    vi.useRealTimers();
    act(() => screen.getByTestId("switch-conversation").click());
    await findBoxInput(LABEL);
    expect(boxText(LABEL)).toBe("");
  });

  it("restores the text and the chips of a draft the app left stored, after a restart", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        [CHANNEL]: {
          text: "Ask @Ada",
          content: boxDoc("Ask ", [MENTION]),
          seedId: 1,
        },
      },
    });
    await restartApp();

    await mountBox(CHANNEL);
    const input = boxInput(LABEL);

    expect(boxText(LABEL)).toContain("Ask");
    expect(
      within(input).getByTestId("bot-box-mention").getAttribute("data-token"),
    ).toBe("<@user-1>");
  });

  it("clears the stored draft when a send is accepted", async () => {
    await mountBox(CHANNEL);
    typeBox("Is CI green?");
    await waitForStore((stored) => stored?.[BOT_ID]?.[CHANNEL] !== undefined);

    typeBox("{Enter}");
    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );

    await waitForStore((stored) => stored?.[BOT_ID]?.[CHANNEL] === undefined);
    expect(useBotDraftsStore.getState().threadBoxes[BOT_ID]).toBeUndefined();
  });

  it("keeps the stored draft when a send fails", async () => {
    await mountBox(CHANNEL);
    typeBox("Is CI green?{Enter}");

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onError?.(new Error("host refused the post")),
    );
    await pastTheDebounce();

    expect(boxText(LABEL)).toBe("Is CI green?");
    await waitForStore(
      (stored) => stored?.[BOT_ID]?.[CHANNEL]?.text === "Is CI green?",
    );
    expect(storedDrafts()?.[BOT_ID]?.[CHANNEL]?.text).toBe("Is CI green?");
  });
});
