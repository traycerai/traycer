// Load the shared boundary mocks before importing the components under test.
import {
  toastSpies,
  SANDBOX_HOST,
  TASK_PIN_HOST,
  SANDBOX_ID,
  SEND_ID,
  SURFACE,
  OCCUPIED_NEW_CHAT_CONTENT,
  mocks,
  NEW_TARGET,
  START_TARGET,
  answerHost,
  answerSandboxRows,
  CODEX_DOWNLOADING,
  CODEX_READY,
  SEEDED,
  seed,
  RUNNER_HOST,
  mount,
  mountInChat,
  createChatCalls,
  listAnswers,
  type Deferred,
  deferred,
  installImmediateExclusiveLocks,
  userSignedIn,
  settleAsyncWork,
  reloadPendingSandboxStores,
  openTask,
} from "./pending-sandbox-send-fixture";

import type { JsonContent } from "@traycer/protocol/common/registry";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import type { SandboxVerbOutcome } from "@/hooks/sandboxes/use-sandbox-verb-mutation";

import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";

import { RunnerHostContext } from "@/providers/runner-host-context";

import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  pendingSend,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";

import { useNewConversationReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";

import { useAuthStore } from "@/stores/auth/auth-store";

import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";

import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  recordCancelledSandboxSend,
  useStoppedSandboxSendReceiptStore,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";

import {
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

import { persistKey, STORE_KEYS } from "@/lib/persist";

import { recordMapStorageKey } from "@/lib/persist/keys";
import {
  PendingSandboxSendStrip,
  PendingSandboxSendsDriver,
} from "../pending-sandbox-sends";

import { StoppedSandboxSendReceiptStrip } from "../stopped-sandbox-send-receipts";

describe("choosing Stop on an unclaimed send", () => {
  const FRESH = Date.now() + 60_000;
  const BACK_IN_COMPOSER_RECEIPT =
    "Stopped api-refactor. Your message wasn't sent; it's back in the composer.";
  const SAVED_DRAFT_RECEIPT =
    "Stopped api-refactor. Your message wasn't sent; it's saved in your drafts.";
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  async function chooseStop(): Promise<void> {
    await chooseStopWith(mount);
  }

  async function chooseStopWith<T>(mounter: () => T): Promise<T> {
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const mounted = mounter();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    return mounted;
  }

  /** The driver stays; the strip, and with it the Stop's attention, can be closed. */
  function mountWithRemovableStrip(): { removeStrip: () => void } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const tree = (withStrip: boolean) => (
      <RunnerHostContext.Provider value={RUNNER_HOST}>
        <QueryClientProvider client={client}>
          <PendingSandboxSendsDriver />
          {withStrip ? (
            <PendingSandboxSendStrip epicId="epic-1" tabId="tab-1" />
          ) : null}
        </QueryClientProvider>
      </RunnerHostContext.Provider>
    );
    const view = render(tree(true));
    return { removeStrip: () => view.rerender(tree(false)) };
  }

  /** Stop pending, the task closed, then a fresh row reads `state` before the Stop answers. */
  async function closeTaskThenRowReads(
    state: "suspended" | "stopped",
  ): Promise<void> {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state });
        await answer.promise;
      });
    });
    const { removeStrip } = await chooseStopWith(mountWithRemovableStrip);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    act(removeStrip);
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state,
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  async function chooseStopAndConfirmRest(): Promise<void> {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    await screen.findByTestId("sandbox-stopped-line");
  }

  function expectSendKept(): void {
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    expect(readStagedSandbox(SURFACE)).not.toBeNull();
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(createChatCalls()).toEqual([]);
  }

  /** Ends an unanswered Stop the way the host eventually does, so no case outlives its own. */
  async function settleStop(
    answer: Deferred<SandboxVerbOutcome>,
  ): Promise<void> {
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  async function createBackgroundStoppedReceipt() {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
      expect(
        toastSpies.activeReceiptToasts.has(`sandbox-stopped:${SEND_ID}`),
      ).toBe(true);
    });
    return { client, view };
  }

  /** A resting row was read after the strip mounted, before the person chose Stop. */
  it("shows Stop on the created sandbox's collapsed and expanded setup line, then marks it pending", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    seed({ ...SEEDED, phase: "creating", created: true, elapsedSeconds: 0 });
    // The run saw the created sandbox awake and moved on to its settings.
    useStagedSandboxStore
      .getState()
      .report(SURFACE, { step: "applying", stepAt: Date.now() });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await settleAsyncWork();

    const line = await screen.findByTestId("sandbox-setup-line");
    expect(
      screen
        .getByTestId("sandbox-setup-line-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(within(line).getByRole("button", { name: "Stop" })).toBeDefined();

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    expect(screen.getByTestId("sandbox-setup-line-detail")).toBeDefined();
    fireEvent.click(within(line).getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
      "Stopping api-refactor · pending",
    );
    expectSendKept();
    await settleStop(answer);
  });

  it("keeps the message and Stop when a list request sent before Stop was chosen resolves at rest after it", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    // The list request leaves before Stop is chosen and answers after it.
    const sentAt = Date.now();
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    const resting = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "stopped",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([resting]));
    mocks.listReadSentAt = sentAt;
    answerSandboxRows([resting], FRESH);

    await act(async () => {
      await Promise.resolve();
    });
    expectSendKept();
    expect(screen.getByTestId("sandbox-setup-stop")).toBeDefined();
    await settleStop(answer);
  });

  it("keeps the Stop boundary across a reload: a list read sent at the boundary holds the send, one sent after it releases it once", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    const boundary =
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequestedAt;
    if (boundary === undefined) throw new Error("the Stop wrote no boundary");

    await reloadPendingSandboxStores();
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequestedAt,
    ).toBe(boundary);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    const resting = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "stopped",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([resting]));

    // Arrives fresh but was sent at the boundary: it proves nothing after the Stop.
    mocks.listReadSentAt = boundary;
    answerSandboxRows([resting], FRESH);
    await act(async () => {
      await Promise.resolve();
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    mocks.listReadSentAt = boundary + 1;
    answerSandboxRows([resting], FRESH + 1);
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
  });

  it("stops the sandbox exactly once, then returns the send once it is at rest", async () => {
    await chooseStop();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the message, the stage and Stop, and says why, when the stop fails", async () => {
    mocks.verbAnswer = Promise.reject(new Error("The sandbox would not stop."));
    mocks.verbAnswer.catch(() => undefined);
    await chooseStop();

    await waitFor(() => {
      expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
        "Couldn't stop api-refactor · SBX-0701",
      );
    });
    expectSendKept();
    const line = screen.getByTestId("sandbox-setup-line");
    expect(
      within(line)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Retry", "Details"]);
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
  });

  it("offers an enabled Retry after remount even when the mutation error was lost", async () => {
    mocks.verbAnswer = Promise.reject(new Error("The sandbox would not stop."));
    mocks.verbAnswer.catch(() => undefined);
    await chooseStop();

    await waitFor(() => {
      expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
        "Couldn't stop api-refactor · SBX-0701",
      );
    });
    expectSendKept();

    await reloadPendingSandboxStores();
    mocks.verbState = { isPending: false, error: null };
    const retryAnswer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = retryAnswer.promise;
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await settleAsyncWork();

    const line = await screen.findByTestId("sandbox-setup-line");
    const retry = within(line).getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(line.textContent).toContain("Couldn't stop api-refactor · SBX-0701");
    expect(within(line).getByRole("button", { name: "Details" })).toBeDefined();
    expectSendKept();

    fireEvent.click(retry);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
      "Stopping api-refactor · pending",
    );
    expectSendKept();
    await settleStop(retryAnswer);
  });

  it("returns nothing and sends nothing while the stop has not answered, then returns the send when it settles", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();

    await act(async () => {
      await Promise.resolve();
    });
    expectSendKept();
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("opens the task's composer on the stopped sandbox with the message when a stop completes in the strip that requested it", async () => {
    await chooseStopAndConfirmRest();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
    // Unnamed, so its picker is live and the staged sandbox carries its Send:
    // a composer named on a stopped host refuses to send.
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
      hostId: null,
    });
    // On the sandbox it was sent to, never the composer's default host: the
    // task draft records it, and the composer stages it when it shows the
    // draft. Nothing is staged or pinned before then.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({
      target: {
        kind: "existing",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        name: "api-refactor",
        verb: "start",
      },
      clientRequestId: null,
    });
    expect(readStagedSandbox(newConversationSurfaceKey("epic-1"))).toBeNull();
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        newConversationSurfaceKey("epic-1")
      ],
    ).toBe(TASK_PIN_HOST);
    expect(document.body.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Choose another host" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
    });
    expect(createChatCalls()).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
  });

  describe("on a task whose composer stages the message's own sandbox", () => {
    const ADD_AGENT_RECEIPT =
      "Stopped api-refactor. Your message wasn't sent; it's in Add agent.";

    afterEach(() => {
      __getOpenEpicRegistryForTests().disposeAll();
    });

    /** The open composer's own hook, mounted before the Stop, stages what the draft names. */
    async function stopWithOpenComposer(chatIds: readonly string[]) {
      openTask(true, chatIds);
      renderHook(() => useNewConversationReturnedSandbox("epic-1", null));
      await chooseStopAndConfirmRest();
      await waitFor(() => {
        expect(
          readStagedSandbox(newConversationSurfaceKey("epic-1")),
        ).toMatchObject({ target: { kind: "existing", hostId: SANDBOX_HOST } });
      });
    }

    function expectAddAgentReceipt(): void {
      const line = screen.getByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(ADD_AGENT_RECEIPT);
      expect(
        within(line).getByRole("button", { name: "Add agent" }),
      ).toBeDefined();
      expect(within(line).getByRole("button", { name: "Start" })).toBeDefined();
      expect(
        within(line).queryByRole("button", { name: "Choose another host" }),
      ).toBeNull();
      expect(line.textContent).not.toContain("api-refactor is stopped");
      expect(screen.queryByTestId("rested-task-message-line")).toBeNull();
    }

    it("keeps the Stopped line, saying the message is in Add agent, once the composer stages its sandbox", async () => {
      await stopWithOpenComposer([]);
      expectAddAgentReceipt();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("keeps the line, with its two actions, after the person closes Add agent", async () => {
      await stopWithOpenComposer([]);

      act(() => {
        useNewConversationModalOpenStore.getState().close();
      });

      expect(useNewConversationModalOpenStore.getState().request).toBeNull();
      expectAddAgentReceipt();
    });

    it("reopens the composer with the message in it on Add agent, keeping the line", async () => {
      await stopWithOpenComposer([]);
      act(() => {
        useNewConversationModalOpenStore.getState().close();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        {
          epicId: "epic-1",
          tabId: "tab-1",
          hostId: null,
        },
      );
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT });
      expectAddAgentReceipt();
    });

    it("says the message is back in the composer, with no Add agent, on a task that has a chat", async () => {
      await stopWithOpenComposer(["chat-1"]);

      const line = screen.getByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
      expect(
        within(line).queryByRole("button", { name: "Add agent" }),
      ).toBeNull();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("still clears the line when the person stages a different sandbox on the task", async () => {
      await stopWithOpenComposer([]);

      act(() => {
        useStagedSandboxStore
          .getState()
          .stage(newConversationSurfaceKey("epic-1"), NEW_TARGET);
      });

      await waitFor(() => {
        expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
      });
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
    });

    it("keeps the line when the composer already held a stage on this sandbox before the Stop landed", async () => {
      openTask(true, []);
      useStagedSandboxStore
        .getState()
        .stage(newConversationSurfaceKey("epic-1"), START_TARGET);
      await chooseStopAndConfirmRest();

      expectAddAgentReceipt();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("keeps the saved-in-drafts line when an occupied composer already held its earlier stage on this sandbox", async () => {
      const occupiedContent: JsonContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "keep my replacement" }],
          },
        ],
      };
      openTask(true, []);
      // Seeded: an earlier give-back left the composer's content, its returned
      // sandbox and the stage the composer made from it.
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", occupiedContent);
      useNewConversationModalStore.getState().setReturnedSandbox("epic-1", {
        target: START_TARGET,
        clientRequestId: null,
      });
      useStagedSandboxStore
        .getState()
        .stage(newConversationSurfaceKey("epic-1"), START_TARGET);
      await chooseStopAndConfirmRest();

      const line = screen.getByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(SAVED_DRAFT_RECEIPT);
      expect(
        within(line).getByRole("button", { name: "Open draft" }),
      ).toBeDefined();
      expect(within(line).getByRole("button", { name: "Start" })).toBeDefined();
      expect(
        within(line).queryByRole("button", { name: "Choose another host" }),
      ).toBeNull();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("clears a cancelled receipt when the composer stages the message's own sandbox", async () => {
      openTask(true, []);
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", MESSAGE_CONTENT);
      useNewConversationModalStore.getState().setReturnedSandbox("epic-1", {
        target: START_TARGET,
        clientRequestId: null,
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "stopped",
          }),
        ],
        1,
      );
      recordCancelledSandboxSend(
        pendingSend({ id: SEND_ID, epicConfirmed: true }),
        {
          kind: "task",
          epicId: "epic-1",
          parentId: null,
          placement: null,
        },
      );
      mount();
      await screen.findByTestId("sandbox-stopped-line");

      renderHook(() => useNewConversationReturnedSandbox("epic-1", null));

      await waitFor(() => {
        expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
      });
      expect(
        readStagedSandbox(newConversationSurfaceKey("epic-1")),
      ).toMatchObject({ target: { kind: "existing" } });
    });
  });

  it("saves the stopped message in drafts when the task composer has newer content", async () => {
    const occupiedContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep my replacement" }],
        },
      ],
    };
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", occupiedContent);

    await chooseStopAndConfirmRest();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: occupiedContent });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(SAVED_DRAFT_RECEIPT);
    // A Stop the person confirmed says "Stopped", never the state footer.
    expect(document.body.textContent).not.toContain("api-refactor is stopped");
    expect(screen.getByRole("button", { name: "Open draft" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Choose another host" }),
    ).toBeNull();
  });

  it("clears the stopped receipt when the person chooses another host", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another host" }),
    );

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(receipt);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
  });

  it("clears a task receipt when an ordinary successful send consumes its composer draft", async () => {
    const taskSurface = newConversationSurfaceKey("epic-1");
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(taskSurface, "pinned-host");

    await chooseStopAndConfirmRest();
    expect(document.body.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
    // The message is back in the task's composer on the stopped sandbox: its
    // draft records it, and the composer's pin is left as it was.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({ target: { kind: "existing", hostId: SANDBOX_HOST } });
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe("pinned-host");

    act(() => {
      useNewConversationModalStore.getState().clearDraft("epic-1");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe("pinned-host");
  });

  it("clears the stopped receipt when a newer send appears in the task", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    act(() => {
      usePendingSandboxSendStore.getState().add(
        pendingSend({
          id: "send-2",
          createdAt: Date.now(),
          text: "write the migration",
        }),
      );
    });

    expect(await screen.findByText("write the migration")).toBeDefined();
    expect(document.body.textContent).not.toContain(receipt);
  });

  it("clears the stopped receipt after the sandbox is started", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
        }),
      ],
      Date.now() + 60_000,
    );

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(receipt);
    });
  });

  it("updates Start in place without losing the background receipt or its actions", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    const initial = toastSpies.activeReceiptToasts.get(id);
    if (initial === undefined)
      throw new Error("Expected the stopped receipt toast");
    const initialView = render(initial.content);
    const initialStart = within(initialView.container).getByRole("button", {
      name: "Start",
    });
    expect(initialStart.hasAttribute("disabled")).toBe(false);

    const startAnswer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = startAnswer.promise;
    fireEvent.click(initialStart);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
      const updated = toastSpies.activeReceiptToasts.get(id);
      expect(updated).toBeDefined();
      expect(updated?.content).not.toBe(initial.content);
    });

    const updated = toastSpies.activeReceiptToasts.get(id);
    if (updated === undefined)
      throw new Error("Expected the updated receipt toast");
    const updatedView = render(updated.content);
    expect(
      within(updatedView.container)
        .getByRole("button", { name: "Start" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(updatedView.container).getByRole("button", {
        name: "Open draft",
      }),
    ).toBeDefined();
    expect(
      within(updatedView.container).queryByRole("button", {
        name: "Choose another host",
      }),
    ).toBeNull();
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.dismiss).not.toHaveBeenCalledWith(id);

    await act(async () => {
      startAnswer.resolve({ kind: "settled", state: "stopped" });
      await startAnswer.promise;
    });
    await waitFor(() => {
      const settled = toastSpies.activeReceiptToasts.get(id);
      expect(settled).toBeDefined();
      expect(settled?.content).not.toBe(updated.content);
    });
    const settled = toastSpies.activeReceiptToasts.get(id);
    if (settled === undefined)
      throw new Error("Expected the settled receipt toast");
    expect(
      within(render(settled.content).container)
        .getByRole("button", { name: "Start" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
  });

  it("hands a background receipt into a mounted strip while dismissing only its toast", async () => {
    const { client, view } = await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
        <StoppedSandboxSendReceiptStrip epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>,
    );

    const strip = await screen.findByTestId("sandbox-stopped-line");
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
    });
    expect(toastSpies.dismiss).toHaveBeenCalledWith(id);
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(within(strip).getByRole("button", { name: "Start" })).toBeDefined();
  });

  it("ignores the old background dismissal after a receipt returns from a tab to a new toast", async () => {
    const { client, view } = await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    const originalToast = toastSpies.activeReceiptToasts.get(id);
    if (originalToast === undefined)
      throw new Error("Expected the original background receipt toast");
    toastSpies.dismissalQueue.deferred = true;

    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
        <StoppedSandboxSendReceiptStrip epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>,
    );
    const strip = await screen.findByTestId("sandbox-stopped-line");
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
      expect(toastSpies.dismissalQueue.callbacks).toHaveLength(1);
    });
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(within(strip).getByRole("button", { name: "Start" })).toBeDefined();

    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(true);
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });
    const republishedToast = toastSpies.activeReceiptToasts.get(id);
    if (republishedToast === undefined)
      throw new Error("Expected the republished background receipt toast");
    expect(republishedToast).not.toBe(originalToast);
    const republishedView = render(republishedToast.content);
    expect(
      within(republishedView.container).getByRole("button", { name: "Start" }),
    ).toBeDefined();

    const oldDismissal = toastSpies.dismissalQueue.callbacks.shift();
    if (oldDismissal === undefined)
      throw new Error("Expected the delayed dismissal callback");
    toastSpies.dismissalQueue.deferred = false;
    act(() => {
      oldDismissal();
    });

    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.activeReceiptToasts.get(id)).toBe(republishedToast);
    expect(
      within(render(republishedToast.content).container).getByRole("button", {
        name: "Start",
      }),
    ).toBeDefined();
  });

  it("removes the durable receipt when the person dismisses its toast", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;

    act(() => {
      toastSpies.dismissByUser(id);
    });

    await waitFor(() => {
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
    });
    expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
  });

  it("retires the receipt toast when its returned draft becomes obsolete", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;

    act(() => {
      useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    });

    await waitFor(() => {
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
    });
    expect(toastSpies.dismiss).toHaveBeenCalledWith(id);
  });

  it("keeps a saved-draft receipt in an app toast when a stop completes after its strip is gone", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    // The strip goes away (reload, background) while the stop is unanswered.
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);

    await waitFor(() => {
      expect(toastSpies.show).toHaveBeenCalled();
    });
    const toastCall = toastSpies.show.mock.calls.at(-1);
    if (toastCall === undefined) throw new Error("Expected stopped-send toast");
    const [toastContent, toastOptions] = toastCall;
    expect(toastOptions?.duration).toBe(Infinity);
    const toastView = render(toastContent);
    expect(toastView.container.textContent).toContain(SAVED_DRAFT_RECEIPT);
    expect(
      within(toastView.container).getByRole("button", { name: "Open draft" }),
    ).toBeDefined();
    expect(
      within(toastView.container).getByRole("button", { name: "Start" }),
    ).toBeDefined();
    expect(
      within(toastView.container).queryByRole("button", {
        name: "Choose another host",
      }),
    ).toBeNull();
    fireEvent.click(
      within(toastView.container).getByRole("button", { name: "Start" }),
    );
    await waitFor(() =>
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start"),
    );
  });

  it("does not recreate a dismissed receipt when the late Stop result follows a row give-back", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });

    // A new window takes over the held Stop while the original verb call waits.
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(toastSpies.show).toHaveBeenCalledTimes(1);
    });
    const [toastContent, toastOptions] = toastSpies.show.mock.calls[0] ?? [];
    expect(toastOptions?.duration).toBe(Infinity);
    expect(render(toastContent).container.textContent).toContain(
      SAVED_DRAFT_RECEIPT,
    );
    if (toastOptions?.onDismiss === undefined)
      throw new Error("Expected the saved-draft toast to dismiss its receipt");
    Reflect.apply(toastOptions.onDismiss, undefined, []);

    await waitFor(() => {
      expect(toastSpies.dismiss).toHaveBeenCalled();
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(mocks.verbState.isPending).toBe(false);
      expect(toastSpies.show).toHaveBeenCalledTimes(1);
    });
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
  });

  it.each(["handoff", "creating"] as const)(
    "never clears the held stop, wakes, creates or dispatches when a repair started earlier succeeds late, in the %s phase",
    async (phase) => {
      const answer = deferred<SandboxVerbOutcome>();
      mocks.verbAnswer = answer.promise;
      seed({ ...SEEDED, phase, created: true, elapsedSeconds: 120 });
      // The settings really are unapplied, so the failure is the row's own.
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            guestConfigured: false,
          }),
        ],
        FRESH,
      );
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      await screen.findByTestId("sandbox-setup-line");
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "settings", code: "SBX-0520" },
        });
      });
      fireEvent.click(
        await screen.findByTestId("sandbox-setup-retry-applying"),
      );
      expect(mocks.repairFinishers).toHaveLength(1);
      fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
      await waitFor(() => {
        expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
      });

      // The repair, started before the Stop, succeeds now.
      await act(async () => {
        for (const finish of mocks.repairFinishers) finish();
        await Promise.resolve();
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
          }),
        ],
        FRESH,
      );

      expectSendKept();
      // The Stop is the send's own record; no stage writer can erase it.
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
      ).toBe(true);
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        answer.resolve({ kind: "settled", state: "stopped" });
        await answer.promise;
      });
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(createChatCalls()).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    },
  );

  it("ends a terminal ask whose guest setup failed while its sandbox was being created, when a Stop that was still moving is followed by a fresh stopped row", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    seed({
      ...SEEDED,
      send: { request: { kind: "terminal" }, text: "" },
      phase: "creating",
      created: true,
      elapsedSeconds: 120,
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          guestConfigured: false,
        }),
      ],
      FRESH,
    );
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await mocks.verbAnswer;
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH + 1,
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps a moving stop across a sign-out that clears every stage, and quietly returns the message on a fresh stopped row once its owner is back", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    await chooseStop();
    await act(async () => {
      await mocks.verbAnswer;
    });
    expectSendKept();

    // Sign-out clears every stage; the pending record survives it.
    cleanup();
    useStagedSandboxStore.getState().clearAll();
    act(() => {
      useAuthStore.getState().setSignedOut();
    });
    userSignedIn();
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_READY);
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
        }),
      ],
      FRESH,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Nothing runs while the stop is unanswered, with the agent ready and the row awake.
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
    ).toBe(true);
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH + 1,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the agent is repaired and the sandbox unfrozen while the stop is pending", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          frozen: true,
        }),
      ],
      FRESH,
    );
    answerHost(SANDBOX_HOST, CODEX_READY);
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
        }),
      ],
      FRESH + 1,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expectSendKept();
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the stop latch across a reload, so a repaired agent still dispatches nothing", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
      kind: "settings",
      code: "pending-send-stop",
    });

    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    await act(async () => {
      await Promise.resolve();
    });

    expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
      kind: "settings",
      code: "pending-send-stop",
    });
    expect(createChatCalls()).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    answer.resolve({ kind: "settled", state: "stopped" });
  });

  it.each([null, "awake"] as const)(
    "keeps the send when the stop settles with the sandbox %s, and returns it on the first fresh read at rest",
    async (state) => {
      mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({
        kind: "settled",
        state,
      });
      await chooseStop();

      await act(async () => {
        await mocks.verbAnswer;
      });
      expectSendKept();

      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "suspended",
          }),
        ],
        FRESH,
      );
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    },
  );

  const SUSPENDED_DRAFT_RECEIPT =
    "build-box is suspended. Your message wasn't sent; it's saved in your drafts.";

  function expectNoStoppedReceipt(): void {
    expect(document.body.textContent).not.toContain("Stopped ");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose another host" }),
    ).toBeNull();
  }

  /** A Stop left unanswered while the sandbox suspends on its own and a fresh row says so. */
  async function suspendBeforeStopAnswers(): Promise<
    Deferred<SandboxVerbOutcome>
  > {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "suspended" });
        await answer.promise;
      });
    });
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    return answer;
  }

  it("says the sandbox is suspended, not Stopped, when a fresh row reads suspended before the Stop answers and the composer is occupied", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await suspendBeforeStopAnswers();

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SUSPENDED_DRAFT_RECEIPT);
    expectNoStoppedReceipt();
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        closed: true,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            verb: "resume",
          },
        },
      },
    ]);
  });

  it("puts the message back in the free composer on its resume pick when a fresh row reads suspended before the Stop answers", async () => {
    await suspendBeforeStopAnswers();

    await screen.findByTestId("sandbox-stopped-line");
    expectNoStoppedReceipt();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: { kind: "existing", hostId: SANDBOX_HOST, verb: "resume" },
      },
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("says the sandbox is suspended, not Stopped, when the Stop itself settles suspended", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      1,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "suspended" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    // The receipt reads the row; the earlier read was too old to return the send itself.
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SUSPENDED_DRAFT_RECEIPT);
    expectNoStoppedReceipt();
  });

  it("still says Stopped, with Start and no host choice, when the row reads stopped before the Stop answers", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "stopped" });
        await answer.promise;
      });
    });
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SAVED_DRAFT_RECEIPT);
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Choose another host" }),
    ).toBeNull();
  });

  it("returns a chat's message to its composer with no Stopped receipt and no state receipt when a fresh row reads suspended before the Stop answers", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "suspended" });
        await answer.promise;
      });
    });
    seed({
      ...SEEDED,
      elapsedSeconds: 120,
      send: { request: { kind: "message", chatId: "existing-chat" } },
    });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mountInChat();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    expect(document.body.textContent).not.toContain("Stopped ");
    expect(screen.getByTestId("sandbox-stopped-line").textContent).toBe(
      "Your message wasn't sent; it's back in the composer.",
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(createChatCalls()).toEqual([]);
  });

  it("puts the message back in the task's composer on its sandbox's resume pick when the task closed before a suspend reached the Stop", async () => {
    await closeTaskThenRowReads("suspended");

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: {
          kind: "existing",
          hostId: SANDBOX_HOST,
          sandboxId: SANDBOX_ID,
          verb: "resume",
        },
      },
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(document.body.textContent).not.toContain("Stopped ");
  });

  it("saves the message in drafts on its sandbox when the task closed with its composer occupied before a suspend reached the Stop", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await closeTaskThenRowReads("suspended");

    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        closed: true,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            verb: "resume",
          },
        },
      },
    ]);
  });

  it("saves the message in drafts with no sandbox pick when the task closed before the sandbox stopped", async () => {
    await closeTaskThenRowReads("stopped");

    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, closed: true, returnedSandbox: null },
    ]);
  });

  /** Shows Stop on an unclaimed send, then makes writes to `storageKey` throw as a full disk would. */
  async function stopWithFailingWrite(storageKey: string) {
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    const stop = await screen.findByTestId("sandbox-setup-stop");

    const originalSetItem = localStorage.setItem.bind(localStorage);
    const failedWrite = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === storageKey) throw new Error("quota exceeded");
        originalSetItem.call(this, key, value);
      });
    const raised: unknown[] = [];
    const onRejection = (reason: unknown) => raised.push(reason);
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      raised.push(event.error);
    };
    process.on("unhandledRejection", onRejection);
    window.addEventListener("error", onError);
    onTestFinished(() => {
      process.off("unhandledRejection", onRejection);
      window.removeEventListener("error", onError);
      failedWrite.mockRestore();
    });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(failedWrite).toHaveBeenCalledWith(storageKey, expect.any(String));
    });
    return { raised };
  }

  it("sends no stop and no create, keeps the message, and raises nothing when the Stop cannot be written to the send's record", async () => {
    const { raised } = await stopWithFailingWrite(
      recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), SEND_ID),
    );
    // One turn of the event loop, where an unhandled rejection surfaces.
    await vi.advanceTimersByTimeAsync(0);

    expect(raised).toEqual([]);
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
    ).not.toBe(true);
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
  });

  it("still stops and gives the message back, raising nothing, when only the stage's projection of the Stop cannot be written", async () => {
    const { raised } = await stopWithFailingWrite(
      recordMapStorageKey(persistKey(STORE_KEYS.stagedSandboxSend), SURFACE),
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(raised).toEqual([]);
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the send while the sandbox is still moving, and returns it on the first fresh read at rest", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    await chooseStop();

    await act(async () => {
      await mocks.verbAnswer;
    });
    expectSendKept();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
  });
});
