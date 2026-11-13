/**
 * A send that carries answers moved into the bot message box (Tracy Bots T186): its
 * refusal, and a send that edits a failed post.
 * The setup is that of `bot-message-composer-draft-persist.test.tsx`
 * (`bot-message-composer-draft-test-support`).
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
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import {
  app,
  boxText,
  EDIT,
  endCase,
  lastSend,
  mountBox,
  RESPONSE,
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
  describe("a send of a box that edits a failed post, with an answer moved in under the edit", () => {
    /** The box editing the failed post, an answer moved in under it, and Send pressed. */
    async function sendWithAnAnswerMovedIn(): Promise<void> {
      vi.useRealTimers();
      ui.rtl.render(<ui.owner.OwnerBoxEditing initial={CHANNEL} edit={EDIT} />);
      await ui.box.findBoxInput(OWNER_LABEL);
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
      expect(boxText()).toBe("Failed post\n\nHold the migration");
      typeBox("{Enter}");
      expect(mocks.send).toHaveBeenCalledTimes(1);
      // The send carries the edit's text and the answer moved in under it.
      const sentText = mocks.send.mock.calls[0][0].text;
      expect(sentText).toContain("Failed post");
      expect(sentText).toContain("Hold the migration");
    }

    function carriedBlocks(): ReadonlyArray<string> {
      return (app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).map(
        (item) => item.block,
      );
    }

    it("empties the box and lets go of the answer when the send lands: the answer does not come back, and nothing is left waiting", async () => {
      await sendWithAnAnswerMovedIn();

      await settleSend(lastSend(), (callbacks) =>
        callbacks.onSuccess?.(RESPONSE),
      );

      expect(boxText()).toBe("");
      expect(carriedBlocks()).toEqual([]);
      expect(
        ui.rtl.screen.queryByTestId("bot-channel-composer-editing"),
      ).toBeNull();
    });

    it("gives the sent document back to the box once, answer included, with nothing left waiting, when the send is refused", async () => {
      await sendWithAnAnswerMovedIn();
      expect(boxText()).toBe("");
      // The store keeps the answer while the send that carries it is out.
      expect(carriedBlocks()).toEqual(["Hold the migration"]);

      await settleSend(lastSend(), (callbacks) =>
        callbacks.onError?.(new Error("host refused the post")),
      );

      expect(boxText()).toBe("Failed post\n\nHold the migration");
      // The edit is in progress, so nothing is kept: the store still holds the answer.
      expect(carriedBlocks()).toEqual(["Hold the migration"]);
      expect(
        ui.rtl.screen.getByTestId("bot-channel-composer-editing"),
      ).toBeTruthy();
    });
  });

  describe("a send's refusal and the answers moved into the box (T186)", () => {
    const MOVED = "Hold the migration";

    /** An answer moves into the box, as a settlement's move does. */
    function moveIn(typed: string): void {
      ui.rtl.act(() => {
        const drafts = app.drafts.getState();
        drafts.setAnswer(BOT_ID, `answer-${typed}`, {
          chosen: [],
          typed,
          sent: null,
          unsureSince: null,
          heldForSettlement: null,
        });
        drafts.moveAnswers(BOT_ID, CHANNEL, [`answer-${typed}`], (taken) => ({
          block: taken.map(([, draft]) => draft.typed).join("\n"),
          notice: "Tess answered first.",
        }));
      });
    }

    function occurrences(text: string): number {
      return boxText().split(text).length - 1;
    }

    /** The box editing the failed post, the answer moved in below it, and the replacement refused. */
    async function refusedReplacement(): Promise<void> {
      vi.useRealTimers();
      ui.rtl.render(<ui.owner.OwnerBoxEditing initial={CHANNEL} edit={EDIT} />);
      await ui.box.findBoxInput(OWNER_LABEL);
      moveIn(MOVED);
      typeBox("{Enter}");
      await settleSend(lastSend(), (callbacks) =>
        callbacks.onError?.(new Error("host refused the post")),
      );
      expect(boxText()).toBe(`Failed post\n\n${MOVED}`);
    }

    it("gives the answer back, once, and keeps it in the store, when the person cancels the edit a refused replacement resumed", async () => {
      await refusedReplacement();

      ui.rtl.act(() => {
        ui.rtl.screen.getByTestId("bot-channel-composer-edit-cancel").click();
      });

      expect(boxText()).toBe(MOVED);
      expect(app.drafts.getState().threadBoxes[BOT_ID]?.[CHANNEL]?.text).toBe(
        MOVED,
      );
    });

    it("shows the answer once in the box opened again after a refused replacement", async () => {
      await refusedReplacement();
      ui.rtl.cleanup();

      vi.useRealTimers();
      ui.rtl.render(<ui.owner.OwnerBox initial={CHANNEL} />);
      await ui.box.findBoxInput(OWNER_LABEL);

      expect(occurrences(MOVED)).toBe(1);
    });

    /** A box holding the moved answer, sent, and closed and opened again while the send is out. */
    async function reopenedDuringSend(): Promise<void> {
      await mountBox(CHANNEL);
      moveIn(MOVED);
      expect(boxText()).toBe(MOVED);
      typeBox("{Enter}");
      ui.rtl.cleanup();
      vi.useRealTimers();
      ui.rtl.render(<ui.owner.OwnerBox initial={CHANNEL} />);
      await ui.box.findBoxInput(OWNER_LABEL);
      expect(boxText()).toBe("");
    }

    it("leaves nothing waiting when the send lands after the box was closed and opened again during it", async () => {
      await reopenedDuringSend();

      await settleSend(lastSend(), (callbacks) =>
        callbacks.onSuccess?.(RESPONSE),
      );

      expect(boxText()).toBe("");
      expect(app.drafts.getState().boxCarries[BOT_ID]?.[CHANNEL] ?? []).toEqual(
        [],
      );
    });

    it("shows the answer once in the box opened again during the send when the send is refused", async () => {
      await reopenedDuringSend();

      await settleSend(lastSend(), (callbacks) =>
        callbacks.onError?.(new Error("host refused the post")),
      );

      await vi.waitFor(() => expect(occurrences(MOVED)).toBe(1));
    });

    /** A box sent with the moved answer, a newer draft typed while the send is out, and the send refused: the old message is offered back. */
    async function offeredBackBesideANewerDraft(): Promise<void> {
      await mountBox(CHANNEL);
      moveIn(MOVED);
      typeBox("{Enter}");
      typeBox("Newer draft");
      await settleSend(lastSend(), (callbacks) =>
        callbacks.onError?.(new Error("host refused the post")),
      );
      expect(
        ui.rtl.screen.getByTestId("bot-channel-composer-send-failed"),
      ).toBeTruthy();
    }

    it("keeps the answer out of the newer draft while the offer shows, and puts it back with the old message, once, on Restore", async () => {
      await offeredBackBesideANewerDraft();
      expect(boxText()).toBe("Newer draft");

      ui.rtl.act(() => {
        ui.rtl.screen
          .getByTestId("bot-channel-composer-send-failed-restore")
          .click();
      });

      expect(occurrences(MOVED)).toBe(1);
    });

    it("leaves the answer in the emptied box when the newer draft is sent instead of the offer", async () => {
      await offeredBackBesideANewerDraft();

      typeBox("{Enter}");

      expect(boxText()).toBe(MOVED);
    });
  });
});
