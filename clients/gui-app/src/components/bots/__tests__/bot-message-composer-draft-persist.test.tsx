/**
 * The bot message box and its kept draft across closing it and restarting the
 * app (Tracy Bots T158): the REAL `BotMessageComposer` over the real
 * `useKeptBoxDraft`, drafts store and `localStorage`. Each case starts the
 * app afresh, so the box, the store and the testing library share one set of
 * modules, and a restart loads them again over what was stored. Each case
 * scripts the send mutation and settles the send through the callbacks
 * the box handed it.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  BOT_ID,
  CHANNEL,
  OWNER_LABEL,
  MENTION,
  boxDoc,
  restart,
  startFresh,
  storeDraftsAsLeft,
  waitForStore,
  type App,
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

const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

/** What a started app loads for a case: the box's owner, the testing library over the same React. */
interface Ui {
  readonly owner: typeof import("@/components/bots/__tests__/bot-box-draft-owner");
  readonly rtl: typeof import("@testing-library/react");
  readonly box: typeof import("@/components/bots/__tests__/bot-box-test-support");
}

async function loadUi(): Promise<Ui> {
  const owner = await import("@/components/bots/__tests__/bot-box-draft-owner");
  const rtl = await import("@testing-library/react");
  const box = await import("@/components/bots/__tests__/bot-box-test-support");
  return { owner, rtl, box };
}

let app: App;
let ui: Ui;

beforeEach(async () => {
  app = await startFresh();
  ui = await loadUi();
});

afterEach(() => {
  ui.rtl.cleanup();
  mocks.send.mockReset();
  app.close();
  vi.useRealTimers();
});

/**
 * The box mounted and its editor found, which polls on the real clock; the
 * fake clock the drafts' write debounce runs on comes after.
 */
async function mountBox(initial: string): Promise<{ unmount: () => void }> {
  vi.useRealTimers();
  const view = ui.rtl.render(<ui.owner.OwnerBox initial={initial} />);
  await ui.box.findBoxInput(OWNER_LABEL);
  startDebounceClock();
  return view;
}

function startDebounceClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function typeBox(sequence: string): void {
  ui.box.typeKeys(OWNER_LABEL, sequence);
}

function boxText(): string {
  return ui.box.boxText(OWNER_LABEL);
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
  await ui.rtl.act(async () => {
    outcome(callbacks);
    await mocks.settled.get(callbacks);
  });
}

describe("<BotMessageComposer /> and its draft on the device", () => {
  it("restores what a conversation's box held when it is mounted again, and shows another conversation's box empty", async () => {
    const first = await mountBox(CHANNEL);
    typeBox("Is CI green?");
    first.unmount();

    await mountBox(CHANNEL);
    expect(boxText()).toBe("Is CI green?");

    vi.useRealTimers();
    ui.rtl.act(() => ui.rtl.screen.getByTestId("switch-conversation").click());
    await ui.box.findBoxInput(OWNER_LABEL);
    expect(boxText()).toBe("");
  });

  it("restores the text and the chips of a draft the app left stored, after a restart", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        [CHANNEL]: {
          text: "Ask @Ada",
          content: boxDoc("Ask ", [MENTION]),
          seedId: 1,
          replyTo: null,
        },
      },
    });
    ui.rtl.cleanup();
    app = await restart();
    ui = await loadUi();

    await mountBox(CHANNEL);

    expect(boxText()).toContain("Ask");
    expect(
      ui.rtl
        .within(ui.box.boxInput(OWNER_LABEL))
        .getByTestId("bot-box-mention")
        .getAttribute("data-token"),
    ).toBe("<@user-1>");
  });

  it("clears the stored draft when a send is accepted", async () => {
    await mountBox(CHANNEL);
    typeBox("Is CI green?");
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.[CHANNEL] !== undefined,
    );

    typeBox("{Enter}");
    await settleSend(lastSend(), (callbacks) =>
      callbacks.onSuccess?.(RESPONSE),
    );

    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.[CHANNEL] === undefined,
    );
    expect(app.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
  });

  it("keeps the stored draft when a send fails", async () => {
    await mountBox(CHANNEL);
    typeBox("Is CI green?{Enter}");

    await settleSend(lastSend(), (callbacks) =>
      callbacks.onError?.(new Error("host refused the post")),
    );

    expect(boxText()).toBe("Is CI green?");
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.[CHANNEL]?.text === "Is CI green?",
    );
  });
});
