/**
 * Where the focus is when an answer moves into the bot message box (Tracy Bots T186).
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
  endCase,
  scriptedSendMutation,
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
  describe("where the focus is when an answer moves into the box (T186)", () => {
    const MOVED = "Hold the migration";

    /** The box beside another field that holds the focus. */
    async function mountedBesideAFocusedField(): Promise<HTMLElement> {
      vi.useRealTimers();
      ui.rtl.render(
        <>
          <input aria-label="Other field" />
          <ui.owner.OwnerBox initial={CHANNEL} />
        </>,
      );
      await ui.box.findBoxInput(OWNER_LABEL);
      const other = ui.rtl.screen.getByLabelText("Other field");
      other.focus();
      expect(document.activeElement).toBe(other);
      return other;
    }

    /** Another person's settlement moves the member's answer into the box. */
    function moveIn(): void {
      ui.rtl.act(() => {
        const drafts = app.drafts.getState();
        drafts.setAnswer(BOT_ID, "answer-1", {
          chosen: [],
          typed: MOVED,
          sent: null,
          unsureSince: null,
          heldForSettlement: null,
        });
        drafts.moveAnswers(BOT_ID, CHANNEL, ["answer-1"], (taken) => ({
          block: taken.map(([, draft]) => draft.typed).join("\n"),
          notice: "Tess answered first.",
        }));
      });
    }

    it("leaves the focus on the other field when an answer moves into an empty box that has no kept draft", async () => {
      const other = await mountedBesideAFocusedField();

      moveIn();

      await vi.waitFor(() => expect(boxText()).toBe(MOVED));
      await ui.rtl.act(async () => {});
      expect(document.activeElement).toBe(other);
    });

    /** The box beside another field, with `text` typed into it. */
    async function mountedWithText(text: string): Promise<HTMLElement> {
      vi.useRealTimers();
      ui.rtl.render(
        <>
          <input aria-label="Other field" />
          <ui.owner.OwnerBox initial={CHANNEL} />
        </>,
      );
      const box = await ui.box.findBoxInput(OWNER_LABEL);
      typeBox(text);
      return box;
    }

    it("leaves the focus, the selected range and the scroll of a focused box as they are when an answer moves into it, and adds the answer after a blank line", async () => {
      const box = await mountedWithText("Hello wide world");
      const editor = ui.box.editorOf(box);
      ui.rtl.act(() => {
        box.focus();
        editor.commands.setTextSelection({ from: 7, to: 11 });
      });
      // What asks the view to scroll is a transaction flagged `scrolledIntoView`.
      const dispatched = vi.spyOn(editor.view, "dispatch");

      moveIn();

      await vi.waitFor(() =>
        expect(boxText()).toBe(`Hello wide world\n\n${MOVED}`),
      );
      expect(document.activeElement).toBe(box);
      expect([editor.state.selection.from, editor.state.selection.to]).toEqual([
        7, 11,
      ]);
      expect(dispatched.mock.calls.some(([tr]) => tr.scrolledIntoView)).toBe(
        false,
      );
    });

    it("leaves the focus on the other field, the caret in the box and the scroll as they are when an answer moves into the unfocused box", async () => {
      const box = await mountedWithText("Hello wide world");
      const editor = ui.box.editorOf(box);
      const other = ui.rtl.screen.getByLabelText("Other field");
      ui.rtl.act(() => {
        editor.commands.setTextSelection(6);
        other.focus();
      });
      const dispatched = vi.spyOn(editor.view, "dispatch");

      moveIn();

      await vi.waitFor(() =>
        expect(boxText()).toBe(`Hello wide world\n\n${MOVED}`),
      );
      expect(document.activeElement).toBe(other);
      expect([editor.state.selection.from, editor.state.selection.to]).toEqual([
        6, 6,
      ]);
      expect(dispatched.mock.calls.some(([tr]) => tr.scrolledIntoView)).toBe(
        false,
      );
    });

    it("leaves the focus on the other field when an answer moves into a box that already has a kept draft", async () => {
      vi.useRealTimers();
      ui.rtl.render(
        <>
          <input aria-label="Other field" />
          <ui.owner.OwnerBox initial={CHANNEL} />
        </>,
      );
      await ui.box.findBoxInput(OWNER_LABEL);
      typeBox("Existing");
      const other = ui.rtl.screen.getByLabelText("Other field");
      other.focus();

      moveIn();

      await vi.waitFor(() => expect(boxText()).toBe(`Existing\n\n${MOVED}`));
      await ui.rtl.act(async () => {});
      expect(document.activeElement).toBe(other);
    });
  });
});
