/**
 * The bot message box and its kept draft across closing it and restarting the
 * app (Tracy Bots T158): the REAL `BotMessageComposer` over the real
 * `useKeptBoxDraft`, drafts store and `localStorage`. Each case starts the
 * app afresh, so the box, the store and the testing library share one set of
 * modules, and a restart loads them again over what was stored. Each case
 * scripts the send mutation and settles the send through the callbacks
 * the box handed it. The suite is split by describe into four files for the
 * test budget; what they share is `bot-message-composer-draft-test-support`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  BOT_ID,
  CHANNEL,
  OWNER_LABEL,
  MENTION,
  boxDoc,
  storeDraftsAsLeft,
  waitForStore,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import {
  app,
  boxText,
  endCase,
  lastSend,
  mountBox,
  RESPONSE,
  restartApp,
  scriptedSendMutation,
  settleSend,
  startCase,
  typeBox,
  ui,
  type SendCallbacks,
} from "@/components/bots/__tests__/bot-message-composer-draft-test-support";

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
  useBotConversationSendMutation: () => scriptedSendMutation(mocks),
}));

beforeEach(() => startCase(mocks));

afterEach(endCase);

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
        },
      },
    });
    await restartApp();

    await mountBox(CHANNEL);

    expect(boxText()).toContain("Ask");
    expect(
      ui.rtl
        .within(ui.box.boxInput(OWNER_LABEL))
        .getByTestId("bot-box-mention")
        .getAttribute("data-token"),
    ).toBe("<@user-1>");
  });

  it("keeps a mention the box holds when answers move into it off a question card, and adds them below, after a blank line", async () => {
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

    ui.rtl.act(() => {
      const drafts = app.drafts.getState();
      drafts.setAnswer(BOT_ID, "answer-key", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-key"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });

    expect(boxText()).toBe("Ask @Ada\n\nHold the migration");
    expect(
      ui.rtl
        .within(ui.box.boxInput(OWNER_LABEL))
        .getByTestId("bot-box-mention")
        .getAttribute("data-token"),
    ).toBe("<@user-1>");
    expect(app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).toEqual(
      [],
    );
  });

  it("adds each of two answers that moved into the box once, when the second moves in before the box acknowledged the first", async () => {
    vi.useRealTimers();
    const answer = (typed: string) => ({
      chosen: [],
      typed,
      sent: null,
      unsureSince: null,
      heldForSettlement: null,
    });
    const compose = (
      taken: ReadonlyArray<readonly [string, { readonly typed: string }]>,
    ) => ({
      block: taken.map(([, draft]) => draft.typed).join("\n"),
      notice: "Tess answered first.",
    });
    ui.rtl.render(
      <ui.owner.OwnerBoxWithSecondMover
        initial={CHANNEL}
        first="First answer"
        move={() =>
          app.drafts
            .getState()
            .moveAnswers(BOT_ID, CHANNEL, ["second"], compose)
        }
      />,
    );
    await ui.box.findBoxInput(OWNER_LABEL);

    ui.rtl.act(() => {
      const drafts = app.drafts.getState();
      drafts.setAnswer(BOT_ID, "first", answer("First answer"));
      drafts.setAnswer(BOT_ID, "second", answer("Second answer"));
      drafts.moveAnswers(BOT_ID, CHANNEL, ["first"], compose);
    });

    expect(boxText()).toBe("First answer\n\nSecond answer");
    expect(app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).toEqual(
      [],
    );
  });

  it("keeps a moved answer in the store's draft, with nothing left waiting, when the box that reported it held is unmounted at once, and shows it once when the box is mounted again", async () => {
    const view = await mountBox(CHANNEL);
    ui.rtl.act(() => {
      const drafts = app.drafts.getState();
      drafts.setAnswer(BOT_ID, "first", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["first"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });
    view.unmount();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.[CHANNEL]?.text).toBe(
      "Hold the migration",
    );
    expect(app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).toEqual(
      [],
    );

    await mountBox(CHANNEL);
    expect(boxText()).toBe("Hold the migration");
  });

  it("composes the edit of a failed post and the answer waiting for the box in the box's first render, the edit's text first, still editing, with the answer left in the store", async () => {
    vi.useRealTimers();
    ui.rtl.act(() => {
      const drafts = app.drafts.getState();
      drafts.setAnswer(BOT_ID, "first", {
        chosen: [],
        typed: "Hold the migration",
        sent: null,
        unsureSince: null,
        heldForSettlement: null,
      });
      drafts.moveAnswers(BOT_ID, CHANNEL, ["first"], (taken) => ({
        block: taken.map(([, draft]) => draft.typed).join("\n"),
        notice: "Tess answered first.",
      }));
    });

    ui.rtl.render(
      <ui.owner.OwnerBoxEditing
        initial={CHANNEL}
        edit={{
          requestId: "request-failed",
          text: "Failed post",
          content: null,
          held: [],
        }}
      />,
    );
    await ui.box.findBoxInput(OWNER_LABEL);

    expect(boxText()).toBe("Failed post\n\nHold the migration");
    expect(
      ui.rtl.screen.getByTestId("bot-channel-composer-editing"),
    ).toBeTruthy();
    expect(
      (app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).map(
        (item) => item.block,
      ),
    ).toEqual(["Hold the migration"]);
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
