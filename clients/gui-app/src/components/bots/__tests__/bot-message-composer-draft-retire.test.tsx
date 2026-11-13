/**
 * What a retiring account's bot message box keeps of a send's refusal and its moved answers (Tracy Bots T186).
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
  lastSend,
  mountBox,
  scriptedSendMutation,
  settleSend,
  startCase,
  typeBox,
  ui,
  withQueryClient,
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
  describe("what a retiring account's box keeps of a send's refusal and its moved answers (T186)", () => {
    const MOVED = "Hold the migration";
    const ACCOUNT_A = "user-account-a";
    const ACCOUNT_B = "user-account-b";

    function signInAs(userId: string): void {
      ui.rtl.act(() => {
        ui.auth.useAuthStore.setState({
          status: "signed-in",
          profile: {
            userId,
            userName: userId,
            email: `${userId}@example.com`,
            avatarUrl: null,
          },
          contextMetadata: { userId, username: userId },
        });
      });
    }

    function signOut(): void {
      ui.rtl.act(() => {
        ui.auth.useAuthStore.setState({
          status: "signed-out",
          profile: null,
          contextMetadata: null,
        });
      });
    }

    afterEach(() => {
      ui.auth.useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
      });
    });

    /** The bridge mounted with account A signed in and its drafts read. */
    async function signedInAsA(): Promise<void> {
      vi.useRealTimers();
      ui.rtl.render(
        withQueryClient(
          <ui.bridge.BotDraftsPersistLifecycleBridge>
            <div />
          </ui.bridge.BotDraftsPersistLifecycleBridge>,
        ),
      );
      signInAs(ACCOUNT_A);
      await vi.waitFor(() =>
        expect(app.drafts.persist.hasHydrated()).toBe(true),
      );
    }

    function moveIn(typed: string): void {
      ui.rtl.act(() => {
        const drafts = app.drafts.getState();
        drafts.setAnswer(BOT_ID, "answer-1", {
          chosen: [],
          typed,
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

    /** The moved answer sent, a newer draft typed while it is out, and the send refused: the old message is the Restore offer. */
    async function offeredBackBesideANewerDraft(): Promise<void> {
      await signedInAsA();
      boxView = await mountBox(CHANNEL);
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

    /** The box this describe's case has open; the bridge stays mounted when it is opened again. */
    let boxView: { readonly unmount: () => void } | null = null;

    /** Runs `action` and resolves once the next read of an account's drafts has finished. */
    function hydrationAfter(action: () => void): Promise<void> {
      return new Promise<void>((resolve) => {
        const stop = app.drafts.persist.onFinishHydration(() => {
          stop();
          resolve();
        });
        action();
      });
    }

    /** The box closed while `action` changes the account, then opened again once the new read finished: what it shows. */
    async function reopenedBoxAfter(action: () => void): Promise<string> {
      vi.useRealTimers();
      const hydrated = hydrationAfter(action);
      boxView?.unmount();
      await hydrated;
      boxView = ui.rtl.render(<ui.owner.OwnerBox initial={CHANNEL} />);
      await ui.box.findBoxInput(OWNER_LABEL);
      return boxText();
    }

    it("gives A the newer draft followed by the failed message, with the moved answer once, when A signs out and signs in again", async () => {
      await offeredBackBesideANewerDraft();

      const shown = await reopenedBoxAfter(() => {
        signOut();
        signInAs(ACCOUNT_A);
      });

      expect(shown).toBe(`Newer draft\n\n${MOVED}`);
    });

    it("gives A the same when another account signed in between", async () => {
      await offeredBackBesideANewerDraft();
      vi.useRealTimers();
      boxView?.unmount();
      await hydrationAfter(() => signInAs(ACCOUNT_B));

      const shown = await reopenedBoxAfter(() => signInAs(ACCOUNT_A));

      expect(shown).toBe(`Newer draft\n\n${MOVED}`);
    });

    it("keeps the moved answer in A's draft when A signs out while the send that carried it is still out", async () => {
      await signedInAsA();
      boxView = await mountBox(CHANNEL);
      moveIn(MOVED);
      typeBox("{Enter}");
      expect(mocks.send).toHaveBeenCalledTimes(1);

      const shown = await reopenedBoxAfter(() => {
        signOut();
        signInAs(ACCOUNT_A);
      });

      expect(shown).toBe(MOVED);
    });

    it("gives A an empty box, not the answer, when the person cleared the box that held the moved answer, sent something else, and A signs out and signs in again while that send is out", async () => {
      await signedInAsA();
      boxView = await mountBox(CHANNEL);
      moveIn(MOVED);
      expect(boxText()).toBe(MOVED);
      ui.box.clearBox(OWNER_LABEL);
      expect(boxText()).toBe("");
      typeBox("Other{Enter}");
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send.mock.calls[0][0].text).toBe("Other");

      const shown = await reopenedBoxAfter(() => {
        signOut();
        signInAs(ACCOUNT_A);
      });

      expect(shown).toBe("");
    });

    it("returns an edit's refusal offered while its box was gone to A's kept draft, as a new message, when A signs out and signs in again", async () => {
      await signedInAsA();
      const view = ui.rtl.render(
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
      typeBox("{Enter}");
      view.unmount();
      await settleSend(lastSend(), (callbacks) =>
        callbacks.onError?.(new Error("host refused the post")),
      );

      const shown = await reopenedBoxAfter(() => {
        signOut();
        signInAs(ACCOUNT_A);
      });

      expect(shown).toBe("Failed post");
      expect(
        ui.rtl.screen.queryByTestId("bot-channel-composer-editing"),
      ).toBeNull();
    });
  });
});
