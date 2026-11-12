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
import type { ReactNode } from "react";
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
  readonly bridge: typeof import("@/providers/bot-drafts-persist-lifecycle-bridge");
  readonly auth: typeof import("@/stores/auth/auth-store");
  readonly query: typeof import("@tanstack/react-query");
}

async function loadUi(): Promise<Ui> {
  const owner = await import("@/components/bots/__tests__/bot-box-draft-owner");
  const rtl = await import("@testing-library/react");
  const box = await import("@/components/bots/__tests__/bot-box-test-support");
  const bridge =
    await import("@/providers/bot-drafts-persist-lifecycle-bridge");
  const auth = await import("@/stores/auth/auth-store");
  const query = await import("@tanstack/react-query");
  return { owner, rtl, box, bridge, auth, query };
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

/** The bridge reads the mutation cache of the app's query client at a switch. */
function withQueryClient(children: ReactNode): ReactNode {
  return (
    <ui.query.QueryClientProvider client={new ui.query.QueryClient()}>
      {children}
    </ui.query.QueryClientProvider>
  );
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
    ui.rtl.cleanup();
    app = await restart();
    ui = await loadUi();
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

  describe("a send of a box that edits a failed post, with an answer moved in under the edit", () => {
    const EDIT = {
      requestId: "request-failed",
      text: "Failed post",
      content: null,
      held: [],
    };

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
    const EDIT = {
      requestId: "request-failed",
      text: "Failed post",
      content: null,
      held: [],
    };
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
