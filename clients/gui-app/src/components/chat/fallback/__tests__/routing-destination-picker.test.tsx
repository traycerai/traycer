import {
  act,
  cleanup,
  fireEvent,
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
  vi,
  type Mock,
} from "vitest";
import { userEvent } from "@testing-library/user-event";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  describeFallbackOutcome,
  describeManualRungRefusal,
} from "@/components/chat/fallback/fallback-copy";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { formatClockTime } from "@/lib/relative-time";
import {
  APP_WIDE_CLIENT_ID,
  CHAT_ID,
  EPIC_ID,
  TAB_CLIENT_ID,
  TAB_HOST_ID,
  TRAVERSAL_ID,
  countdownPending,
  heldLease,
  kit,
  resetKit,
  session,
} from "./routing-picker-kit";
import {
  ATTEMPT_MESSAGE_ID,
  ATTEMPT_TURN_ID,
  CHOOSING_PENDING,
  FAILED,
  FAILED_PROFILE,
  HOLD_PENDING,
  RESETS_AT,
  TARGET,
  WORK_PROFILE,
  confirmButton,
  countdown,
  countdownAt,
  failedAttempt,
  failedTurn,
  footerConfirm,
  listing,
  mount,
  mountAs,
  mountTrigger,
  open,
  option,
  seedProviders,
  statusLines,
  waiting,
} from "./routing-picker-scene";
import {
  fallbackModelTarget,
  fallbackProfileTarget,
  listTargetsResponse,
} from "./fallback-fixtures";

/**
 * The routing chooser as a unit: the wrapper around the composer's model
 * picker. The picker's own injected-row behaviour is pinned in
 * `home/__tests__/harness-model-picker.test.tsx`; the rows' rules and the
 * listing's states in `routing-destination-picker-rows.test.tsx`; the hold
 * against the REAL session store in
 * `routing-destination-picker-lease-integration.test.tsx`. This file is what
 * the wrapper alone owns: the store it never lets write, the host every read
 * goes to, the hold, what a confirm sends, and where each answer goes.
 */

vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (await import("./routing-picker-kit")).hostClientModule(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (await import("./routing-picker-kit")).catalogModule(),
);
vi.mock("@/hooks/providers/use-providers-list-query", async () =>
  (await import("./routing-picker-kit")).providersListModule(),
);
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", async () =>
  (await import("./routing-picker-kit")).providersEnsurePackModule(),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-enabled-mutation",
  async () =>
    (await import("./routing-picker-kit")).providersSetProfileEnabledModule(),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", async () =>
  (await import("./routing-picker-kit")).reactiveHostReadinessModule(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (await import("./routing-picker-kit")).hostReachabilityModule(),
);
vi.mock("@/hooks/host/use-addressable-host-id", async () =>
  (await import("./routing-picker-kit")).addressableHostIdModule(),
);
vi.mock("@/hooks/host/use-host-directory-entry", async () =>
  (await import("./routing-picker-kit")).hostDirectoryEntryModule(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (await import("./routing-picker-kit")).hostDirectoryListModule(),
);
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", async () =>
  (await import("./routing-picker-kit")).usageComparisonModule(),
);
vi.mock("@/components/chat/fallback/use-fallback-targets", async () =>
  (await import("./routing-picker-kit")).listTargetsModule(),
);
vi.mock("@/components/chat/fallback/use-fallback-choice-lease", async () =>
  (await import("./routing-picker-kit")).leaseModule(),
);
vi.mock("@/hooks/host/use-host-scoped-mutation", async () =>
  (await import("./routing-picker-kit")).hostScopedMutationModule(),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  (await import("./routing-picker-kit")).registryModule(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) =>
    (await import("./routing-picker-kit")).identityModule(
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >(),
    ),
);
vi.mock("@/stores/tabs/use-system-tab-modal", async () =>
  (await import("./routing-picker-kit")).systemTabModalModule(),
);
vi.mock("react-virtuoso", async () =>
  (await import("./routing-picker-kit")).virtuosoModule(),
);
vi.mock("sonner", async () => ({
  toast: (await import("./routing-picker-kit")).kit.toast,
}));

/**
 * The store the wrapper builds, with `setOnSettingsChange` wrapped so a suite
 * can prove nothing ever installs a writer. The wrapper is the only caller of
 * `createComposerToolbarStore` under test, so every entry is its store.
 */
const created = vi.hoisted(
  () =>
    [] as Array<{
      readonly options: unknown;
      readonly setOnSettingsChange: Mock;
      readonly store: ComposerToolbarStore;
    }>,
);

vi.mock("@/stores/composer/composer-toolbar-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/composer/composer-toolbar-store")
    >();
  return {
    ...actual,
    createComposerToolbarStore: (
      options: Parameters<typeof actual.createComposerToolbarStore>[0],
    ) => {
      const store = actual.createComposerToolbarStore(options);
      const spy = vi.fn(store.getState().setOnSettingsChange);
      store.setState({ setOnSettingsChange: spy });
      created.push({ options, setOnSettingsChange: spy, store });
      return store;
    },
  };
});

function lastStore(): ComposerToolbarStore {
  const entry = created.at(-1);
  if (entry === undefined) throw new Error("no chooser store was created");
  return entry.store;
}

/** The footer's switch sentence, destination included, as one string. */
function consequence(): string {
  return screen.getByText(/^Replays this message on/).textContent;
}

/** Only the Suggested rows: the ones the wrapper injected. */
function suggested(): HTMLElement[] {
  return screen
    .getAllByRole("option")
    .filter((row) => row.hasAttribute("data-suggestion-action"));
}

/** A catalog row: an option the wrapper did NOT inject. */
function catalogRow(name: RegExp): HTMLElement {
  const rows = screen
    .getAllByRole("option", { name })
    .filter((row) => !row.hasAttribute("data-suggestion-action"));
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** One Codex model row whose HOST target the client branch cannot rebuild. */
function listingWithModelTarget(target: ChatRunSettings) {
  return listTargetsResponse({
    outcome: "listed",
    failedTuple: FAILED,
    profileTargets: [],
    modelTargets: [
      fallbackModelTarget({
        groupId: "grp-internal-secret",
        harnessId: target.harnessId,
        modelFamily: target.model,
        model: target.model,
        reasoningEffort: target.reasoningEffort,
        profileId: target.profileId,
        severity: "ok",
        usedPercent: 20,
        target,
        warnings: [],
        selectable: true,
        skip: null,
      }),
    ],
    modelTargetsSkip: null,
  });
}

const HAIKU_SEED: ChatRunSettings = {
  ...FAILED,
  model: "claude-haiku-4",
  reasoningEffort: null,
};

function haikuEntry(seed: ChatRunSettings) {
  return {
    kind: "failed-turn" as const,
    attempt: failedAttempt(["switch"]),
    seedTuple: seed,
  };
}

function haikuModelRow(input: {
  readonly groupId: string;
  readonly target: ChatRunSettings;
}) {
  return fallbackModelTarget({
    groupId: input.groupId,
    harnessId: input.target.harnessId,
    modelFamily: input.target.model,
    model: input.target.model,
    reasoningEffort: input.target.reasoningEffort,
    profileId: input.target.profileId,
    severity: "ok",
    usedPercent: 10,
    target: input.target,
    warnings: [],
    selectable: true,
    skip: null,
  });
}

describe("RoutingDestinationPicker", () => {
  beforeEach(() => {
    resetKit();
    created.length = 0;
    seedProviders();
    kit.listData = listing({ recommendedWork: false });
    useComposerHarnessMemoryStore.getState().resetForTests();
    useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  describe("the store: a staging area, never a writer", () => {
    it("builds one standalone setting store with no writer, and never installs one across open, rail click, pick, effort and confirm", async () => {
      mount(failedTurn(["retry", "switch"]));
      expect(created).toHaveLength(1);
      const first = created[0];
      expect(first.options).toMatchObject({
        purpose: "setting",
        onSettingsChange: null,
        hostId: null,
        reasoningFallback: "model-default",
      });

      await open();
      fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
      fireEvent.click(option(/GPT-4\.1/));
      fireEvent.click(footerConfirm());

      expect(first.setOnSettingsChange).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);

      // Control: the spy is the store's own action, so it is not silent by
      // construction.
      first.store.getState().setOnSettingsChange(null);
      expect(first.setOnSettingsChange).toHaveBeenCalledTimes(1);
    });

    it("re-seeds the store from the failed tuple on every open, so a pick abandoned by closing does not survive", async () => {
      mount(failedTurn(["switch"]));
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("tab", { name: "Codex" }));
      fireEvent.click(option(/GPT-4\.1/));
      expect(lastStore().getState().selection.modelSlug).toBe("gpt-4.1");

      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      await open();

      // Re-seeded from the failed tuple, then the preselect lands the first
      // usable row again - the abandoned GPT-4.1 pick is what does not return.
      expect(lastStore().getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "claude-sonnet-4",
        profileId: WORK_PROFILE,
      });
    });

    it("writes no composer memory: not on a pick, not on a rail click, not on confirm", async () => {
      const listener = vi.fn();
      const unsubscribe = useComposerHarnessMemoryStore.subscribe(listener);
      const before = useComposerHarnessMemoryStore.getState().byHost;
      mount(failedTurn(["switch"]));

      await open();
      fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
      fireEvent.click(option(/GPT-4\.1/));
      fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(listener).not.toHaveBeenCalled();
      expect(useComposerHarnessMemoryStore.getState().byHost).toBe(before);
      unsubscribe();
    });
  });

  describe("the machine: everything goes to the TAB's host", () => {
    it("pushes the catalog, reads the providers, lists targets, probes usage and sends the verb through the tab client, never the app-wide one", async () => {
      mount(failedTurn(["retry", "switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      fireEvent.click(footerConfirm());

      const catalogClients = kit.catalogCalls
        .filter((call) => call.enabled)
        .map((call) => call.clientId);
      expect(catalogClients.length).toBeGreaterThan(0);
      expect(new Set(catalogClients)).toEqual(new Set([TAB_CLIENT_ID]));
      expect(kit.catalogCalls.some((call) => call.hook === "harnesses")).toBe(
        true,
      );
      expect(kit.catalogCalls.some((call) => call.hook === "models")).toBe(
        true,
      );

      const listClients = kit.listCalls
        .filter((call) => call.enabled)
        .map((call) => call.clientId);
      expect(listClients.length).toBeGreaterThan(0);
      expect(new Set(listClients)).toEqual(new Set([TAB_CLIENT_ID]));

      expect(kit.providerCalls).not.toContain(APP_WIDE_CLIENT_ID);
      expect(kit.labelCalls).not.toContain(APP_WIDE_CLIENT_ID);
      expect(kit.usageProbeCalls.length).toBeGreaterThan(0);
      for (const probe of kit.usageProbeCalls) {
        expect(probe.runTargetHostId).toBe(TAB_HOST_ID);
      }
      expect(kit.mutations.map((call) => call.clientId)).toEqual([
        TAB_CLIENT_ID,
      ]);
    });

    it("lists nothing while closed", () => {
      mount(failedTurn(["switch"]));

      expect(kit.listCalls.filter((call) => call.enabled)).toEqual([]);
    });

    it("asks for the listing with the entry's own selector: an attempt for the error row, a traversal and revision for the cards", async () => {
      const failed = mount(failedTurn(["switch"]));
      await open();
      expect(
        kit.listCalls.filter((call) => call.enabled).at(-1)?.selector,
      ).toEqual({
        kind: "attempt",
        userMessageId: ATTEMPT_MESSAGE_ID,
        turnId: ATTEMPT_TURN_ID,
      });
      failed.unmount();

      kit.listCalls = [];
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();
      expect(
        kit.listCalls.filter((call) => call.enabled).at(-1)?.selector,
      ).toEqual({ kind: "traversal", traversalId: TRAVERSAL_ID, revision: 2 });
    });
  });

  describe("the hold", () => {
    it("takes the hold on open and releases it on close - on the countdown alone", async () => {
      const view = mount(countdownAt(HOLD_PENDING));
      expect(kit.hold).not.toHaveBeenCalled();

      const dialog = await open();
      // Asked on open, and asked again by the retire guard while the lease is
      // still unminted: the session store dedupes the two (see the
      // real-store integration suite), so what matters here is who is asked.
      expect(kit.hold).toHaveBeenCalled();
      for (const call of kit.hold.mock.calls) {
        expect(call).toEqual([TRAVERSAL_ID]);
      }
      expect(kit.release).not.toHaveBeenCalled();

      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(kit.release).toHaveBeenCalledTimes(1);
      });
      view.unmount();
      // Closed before it unmounted: nothing further to hand back.
      expect(kit.release).toHaveBeenCalledTimes(1);
    });

    it("holds nothing for the waiting card or the error row", async () => {
      const view = mount(waiting());
      const dialog = await open();
      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      view.unmount();

      mount(failedTurn(["switch"]));
      await open();

      expect(kit.hold).not.toHaveBeenCalled();
      expect(kit.release).not.toHaveBeenCalled();
    });

    it("re-asks the hold when a frame retires the lease under the open chooser in hold - once per frame, not per render", async () => {
      kit.lease = heldLease("held", "tok-1");
      const view = mount(countdownAt(HOLD_PENDING));
      await open();
      expect(kit.hold).toHaveBeenCalledTimes(1);

      // A reconnect retires the old epoch's token.
      kit.lease = null;
      view.rerenderWith(countdownAt({ ...HOLD_PENDING, revision: 5 }));
      expect(kit.hold).toHaveBeenCalledTimes(2);

      // The next frame with still no lease asks again; a bare re-render of the
      // same frame does not.
      view.rerenderWith(countdownAt({ ...HOLD_PENDING, revision: 6 }));
      expect(kit.hold).toHaveBeenCalledTimes(3);
    });

    it("does not re-ask outside hold: a frozen or settled window has no clock to stop", async () => {
      kit.lease = heldLease("held", "tok-1");
      const view = mount(countdownAt(HOLD_PENDING));
      await open();
      kit.hold.mockClear();

      kit.lease = null;
      view.rerenderWith(countdownAt(CHOOSING_PENDING));

      expect(kit.hold).not.toHaveBeenCalled();
    });

    it("does not re-ask while closed", () => {
      kit.lease = null;
      const view = mount(countdownAt(HOLD_PENDING));
      view.rerenderWith(countdownAt({ ...HOLD_PENDING, revision: 9 }));

      expect(kit.hold).not.toHaveBeenCalled();
    });

    it("releases on unmount while open - the one close it never hears about", async () => {
      kit.lease = heldLease("held", "tok-1");
      const view = mount(countdown());
      await open();
      expect(kit.release).not.toHaveBeenCalled();

      view.unmount();

      expect(kit.release).toHaveBeenCalledTimes(1);
    });

    it("does not release on unmount when it was never opened", () => {
      const view = mount(countdown());
      view.unmount();

      expect(kit.release).not.toHaveBeenCalled();
    });

    it("does not release on the close an applied pick causes - the traversal advanced, there is no frozen remainder to hand back", async () => {
      kit.lease = heldLease("held", "tok-1");
      const view = mount(countdown());
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "applied", detail: null };
      fireEvent.click(footerConfirm());

      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      expect(kit.release).not.toHaveBeenCalled();
      view.unmount();
      expect(kit.release).not.toHaveBeenCalled();
    });

    it("releases on the close a REFUSED pick does not cause: dismissing after a refusal still hands the window back", async () => {
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      const dialog = await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      fireEvent.click(footerConfirm());
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();

      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(kit.release).toHaveBeenCalledTimes(1);
      });
    });

    it("says the countdown was not paused when the host refused the hold, keeps a live region for it, and will not send a switch", async () => {
      kit.lease = heldLease("refused", null);
      mount(countdown());
      await open();

      expect(statusLines()).toContain("Couldn't pause the countdown.");
      // The pick can be made, and cannot be sent while the window runs.
      fireEvent.click(option(/Codex · Codex Team/));
      expect(footerConfirm().disabled).toBe(true);
    });
  });

  describe("the confirm", () => {
    it("is disabled on a countdown switch until the lease is held AND the frame says choosing, and says so while it waits", async () => {
      kit.lease = null;
      const view = mount(countdownAt(HOLD_PENDING));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));

      expect(screen.getByText("Pausing the countdown…")).toBeDefined();
      expect(footerConfirm().disabled).toBe(true);

      // Held, but the frame still runs the countdown: not yet.
      kit.lease = heldLease("held", "tok-1");
      view.rerenderWith(countdownAt(HOLD_PENDING));
      expect(footerConfirm().disabled).toBe(true);
      expect(screen.getByText("Pausing the countdown…")).toBeDefined();

      // Choosing but no token: still not.
      kit.lease = heldLease("pending", null);
      view.rerenderWith(countdownAt(CHOOSING_PENDING));
      expect(footerConfirm().disabled).toBe(true);

      // Both halves.
      kit.lease = heldLease("held", "tok-1");
      view.rerenderWith(countdownAt({ ...CHOOSING_PENDING, revision: 3 }));
      expect(footerConfirm().disabled).toBe(false);
      expect(
        screen.getByText("Countdown paused while you choose."),
      ).toBeDefined();
    });

    it("is disabled while nothing has moved, and for a viewer who cannot act", async () => {
      // No usable suggested row, so nothing is preselected.
      kit.listData = {
        ...listing({ recommendedWork: false }),
        profileTargets: [],
        modelTargets: [],
      };
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(footerConfirm().disabled).toBe(true);

      fireEvent.click(option(/Claude Opus 4/));
      expect(footerConfirm().disabled).toBe(false);
      view.unmount();

      mountAs(failedTurn(["switch"]), false);
      // The trigger goes quiet for a viewer, so the chooser cannot be opened
      // from it at all.
      expect(confirmButton("Choose differently…").disabled).toBe(true);
    });

    it("is disabled while a send is in flight, and says what the click will do in the consequence line", async () => {
      kit.deferResponses = true;
      mount(countdown());
      kit.lease = heldLease("held", "tok-1");
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      expect(
        screen.getByText(
          /in a new session from this transcript\. 2 queued messages move with it\.$/,
        ),
      ).toBeDefined();
      fireEvent.click(footerConfirm());

      expect(footerConfirm().disabled).toBe(true);
      expect(kit.mutations).toHaveLength(1);
      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
    });

    it("Enter on the focused footer Switch is the button's own activation: one send, the picked target, and the list's active row is not selected by it", async () => {
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      const dialog = await open();
      fireEvent.click(option(/Codex · Codex Team/));
      const picked = lastStore().getState().selection;
      // Walk the list's ACTIVE row somewhere else, so a stray row selection
      // by the Enter would be visible as a moved store.
      const search = within(dialog).getByRole("textbox");
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "ArrowDown" });

      act(() => {
        footerConfirm().focus();
      });
      await userEvent.keyboard("{Enter}");

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        method: "chat.fallback.chooseTarget",
        variables: { target: TARGET, leaseToken: "tok-1" },
      });
      expect(lastStore().getState().selection).toEqual(picked);
    });

    it("Enter on the focused footer Retry confirm sends exactly one runManualRung retry", async () => {
      mount(failedTurn(["retry", "switch"]));
      const dialog = await open();
      fireEvent.click(option(/Try Personal again/));
      const before = lastStore().getState().selection;
      fireEvent.keyDown(within(dialog).getByRole("textbox"), {
        key: "ArrowDown",
      });

      act(() => {
        footerConfirm().focus();
      });
      await userEvent.keyboard("{Enter}");

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        method: "chat.fallback.runManualRung",
        variables: { rung: "retry", target: null },
      });
      expect(lastStore().getState().selection).toEqual(before);
    });

    it("the switch sentence names the destination and moves with the selection: account, then another provider, then an effort", async () => {
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      // The preselect: the recommended account, on the failed model.
      expect(consequence()).toBe(
        "Replays this message on claude-sonnet-4 on Work in a new session from this transcript. 2 queued messages move with it.",
      );

      fireEvent.click(option(/Codex · Codex Team/));
      expect(consequence()).toBe(
        "Replays this message on Codex · gpt-5 on Codex Team in a new session from this transcript. 2 queued messages move with it.",
      );

      act(() => {
        lastStore().getState().setReasoning("high");
      });
      expect(consequence()).toBe(
        "Replays this message on Codex · gpt-5 · high on Codex Team in a new session from this transcript. 2 queued messages move with it.",
      );
    });

    it("the queue clause follows the frame's count: one, none, and no count at all on the error row", async () => {
      kit.lease = heldLease("held", "tok-1");
      const one = mount(
        countdownAt(
          countdownPending({
            state: "choosing",
            revision: 2,
            queuedItemsMoving: 1,
          }),
        ),
      );
      await open();
      expect(consequence()).toMatch(
        /transcript\. 1 queued message moves with it\.$/,
      );
      one.unmount();

      const none = mount(
        countdownAt(
          countdownPending({
            state: "choosing",
            revision: 2,
            queuedItemsMoving: 0,
          }),
        ),
      );
      await open();
      expect(consequence()).toMatch(/from this transcript\.$/);
      none.unmount();

      mount(failedTurn(["switch"]));
      await open();
      expect(consequence()).toMatch(
        /from this transcript\. Any queued messages move with it\.$/,
      );
    });
  });

  describe("what a confirm sends", () => {
    it("a Suggested pick sends the host-built target unchanged: a cross-provider model row, over the countdown, with the lease token", async () => {
      // A host target the client branch could not have produced: a different
      // permission mode, and a service tier. The client branch keeps the FAILED
      // tuple's permission mode (`auto_accept_edits`) and nulls a tier the
      // picked model does not offer (the kit's Codex model offers none), so a
      // send that rebuilt the tuple would come out with both fields wrong.
      const hostTarget: ChatRunSettings = {
        ...TARGET,
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingWithModelTarget(hostTarget);
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(option(/Codex · Codex Team/));
      expect(footerConfirm().textContent).toContain("Switch");
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toEqual([
        {
          clientId: TAB_CLIENT_ID,
          method: "chat.fallback.chooseTarget",
          variables: {
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            traversalId: TRAVERSAL_ID,
            revision: 2,
            target: hostTarget,
            leaseToken: "tok-1",
          },
        },
      ]);
      expect(kit.mutations[0].variables).toMatchObject({
        target: { permissionMode: "full_access", serviceTier: "fast" },
      });
    });

    it("changing the effort after picking a Suggested row that names one sends the CLIENT tuple: the new effort, the failed tuple's permission and agent mode, not the row's host target", async () => {
      const hostTarget: ChatRunSettings = {
        ...TARGET,
        permissionMode: "full_access",
        reasoningEffort: "high",
      };
      kit.listData = listingWithModelTarget(hostTarget);
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      // The row is what is checked while its own effort stands.
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");

      act(() => {
        lastStore().getState().setReasoning("low");
      });
      // ...and stops being checked the moment the effort is somewhere else.
      expect(suggested()[0].getAttribute("aria-selected")).toBe("false");
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual({
        ...FAILED,
        harnessId: "codex",
        model: TARGET.model,
        profileId: TARGET.profileId,
        reasoningEffort: "low",
        serviceTier: null,
      });
    });

    it("a Suggested row whose target effort is null is still the checked row, and its host target is what is sent, on a model that advertises efforts and a default", async () => {
      // The failed tuple's model advertises low/high with default "high" and
      // the tuple itself has effort null ("model default"). The preselect
      // commits the account row with a raw effort of "", which the store
      // DERIVES to "high". Matching on the derived value would leave the row
      // unchecked and send a client tuple with "high".
      const seed: ChatRunSettings = {
        ...FAILED,
        model: "claude-haiku-4",
        reasoningEffort: null,
      };
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: seed,
        profileTargets: [
          fallbackProfileTarget({
            profileId: WORK_PROFILE,
            label: "Work",
            severity: "ok",
            usedPercent: 10,
            recommended: true,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount({
        kind: "failed-turn",
        attempt: failedAttempt(["switch"]),
        seedTuple: seed,
      });
      await open();

      expect(lastStore().getState().selection.profileId).toBe(WORK_PROFILE);
      expect(lastStore().getState().reasoning).toBe("high");
      expect(lastStore().getState().values.reasoning).toBe("");
      const row = suggested()[0];
      expect(row.textContent).toContain("Recommended");
      expect(row.getAttribute("aria-selected")).toBe("true");
      // Not the catalog row for the same model.
      expect(
        catalogRow(/Claude Haiku 4/).getAttribute("aria-selected"),
      ).not.toBe("true");

      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual({
        ...seed,
        profileId: WORK_PROFILE,
      });
      expect(kit.mutations[0].variables).toMatchObject({
        target: { reasoningEffort: null },
      });
    });

    it("R2-3a: an explicit-effort Suggested row is the checked row when plain clicks land on the same model at the effort it resolves to, and its host target is sent", async () => {
      // The kit's Codex has one account, so the picker shows no account strip
      // and a plain catalog click commits the ambient account: the row is on
      // that account (`profileId: null`) for "same account" to hold.
      const hostTarget: ChatRunSettings = {
        ...TARGET,
        profileId: null,
        reasoningEffort: "low",
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingWithModelTarget(hostTarget);
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(suggested()[0]);
      // A plain catalog row on the same provider and account, then back.
      fireEvent.click(catalogRow(/GPT-4\.1/));
      fireEvent.click(catalogRow(/GPT-5/));

      // gpt-5 advertises low/medium/high and no default, so an unset effort
      // resolves to "low" - the row's own.
      expect(lastStore().getState().values.reasoning).toBe("");
      expect(lastStore().getState().reasoning).toBe("low");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");
      expect(catalogRow(/GPT-5/).getAttribute("aria-selected")).not.toBe(
        "true",
      );

      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual(hostTarget);
      expect(kit.mutations[0].variables).toMatchObject({
        target: {
          permissionMode: "full_access",
          serviceTier: "fast",
          reasoningEffort: "low",
        },
      });
    });

    it("R2-3a: the same for a real explicit model default - a Suggested claude-haiku-4 row at its default 'high', reached from another model by plain clicks", async () => {
      const hostTarget: ChatRunSettings = {
        ...FAILED,
        model: "claude-haiku-4",
        reasoningEffort: "high",
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingWithModelTarget(hostTarget);
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(suggested()[0]);
      fireEvent.click(catalogRow(/Claude Opus 4/));
      fireEvent.click(catalogRow(/Claude Haiku 4/));

      expect(lastStore().getState().values.reasoning).toBe("");
      expect(lastStore().getState().reasoning).toBe("high");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");
      expect(
        catalogRow(/Claude Haiku 4/).getAttribute("aria-selected"),
      ).not.toBe("true");

      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual(hostTarget);
    });

    it("R2-3b: clicking a null-effort row again after choosing an effort restores the model default, checks the row, and sends its null-effort target", async () => {
      useLayoutStore.getState().setComposerReasoningFooterControl("list");
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: HAIKU_SEED,
        profileTargets: [
          fallbackProfileTarget({
            profileId: WORK_PROFILE,
            label: "Work",
            severity: "ok",
            usedPercent: 10,
            recommended: true,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount(haikuEntry(HAIKU_SEED));
      await open();
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "Low" }));
      expect(lastStore().getState().values.reasoning).toBe("low");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("false");

      fireEvent.click(suggested()[0]);
      expect(lastStore().getState().values.reasoning).toBe("");
      expect(lastStore().getState().reasoning).toBe("high");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");

      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual({
        ...HAIKU_SEED,
        profileId: WORK_PROFILE,
      });
      expect(kit.mutations[0].variables).toMatchObject({
        target: { reasoningEffort: null },
      });
    });

    it("R2-3b: two Suggested rows for one (harness, model, account) - explicit low and no effort - are checked one at a time by click, and the confirm sends the checked one's target", async () => {
      const lowTarget: ChatRunSettings = {
        ...HAIKU_SEED,
        profileId: WORK_PROFILE,
        reasoningEffort: "low",
      };
      const nullTarget: ChatRunSettings = {
        ...HAIKU_SEED,
        profileId: WORK_PROFILE,
        reasoningEffort: null,
        permissionMode: "full_access",
      };
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: HAIKU_SEED,
        profileTargets: [],
        modelTargets: [
          haikuModelRow({ groupId: "grp-low", target: lowTarget }),
          haikuModelRow({ groupId: "grp-null", target: nullTarget }),
        ],
        modelTargetsSkip: null,
      });
      mount(haikuEntry(HAIKU_SEED));
      await open();
      expect(suggested()).toHaveLength(2);
      const [low, none] = suggested();

      fireEvent.click(low);
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");
      expect(suggested()[1].getAttribute("aria-selected")).toBe("false");

      fireEvent.click(none);
      expect(suggested()[1].getAttribute("aria-selected")).toBe("true");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("false");

      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual(nullTarget);
    });

    it("a Suggested profile row sends the failed tuple with only the account swapped", async () => {
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(option(/^Work/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual({
        ...FAILED,
        profileId: WORK_PROFILE,
      });
    });

    it("a pick that is NOT a Suggested row sends a client tuple over the failed tuple, keeping its permission and agent mode", async () => {
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual({
        ...FAILED,
        harnessId: "claude",
        model: "claude-opus-4",
        profileId: FAILED_PROFILE,
        reasoningEffort: null,
        serviceTier: null,
      });
    });

    it("the waiting card sends chooseTarget with no lease token at all", async () => {
      mount(waiting());
      await open();

      fireEvent.click(option(/Codex · Codex Team/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        method: "chat.fallback.chooseTarget",
        variables: {
          traversalId: TRAVERSAL_ID,
          revision: 3,
          target: TARGET,
          leaseToken: null,
        },
      });
    });

    it("the error row sends runManualRung switch bound to BOTH ids of the attempt", async () => {
      mount(failedTurn(["retry", "switch"]));
      await open();

      fireEvent.click(option(/Codex · Codex Team/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toEqual([
        {
          clientId: TAB_CLIENT_ID,
          method: "chat.fallback.runManualRung",
          variables: {
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            rung: "switch",
            target: TARGET,
            userMessageId: ATTEMPT_MESSAGE_ID,
            turnId: ATTEMPT_TURN_ID,
          },
        },
      ]);
    });

    it("Retry and Wait are staged rows: they move nothing in the store, relabel the confirm, and dispatch their own verb with no target", async () => {
      mount(failedTurn(["retry", "switch", "wait_once"]));
      await open();
      const before = lastStore().getState().selection;

      fireEvent.click(option(/Try Personal again/));
      expect(lastStore().getState().selection).toBe(before);
      expect(footerConfirm().textContent).toContain("Retry");
      expect(
        screen.getByText(
          "Runs this message again on the same account and model.",
        ),
      ).toBeDefined();
      fireEvent.click(footerConfirm());
      expect(kit.mutations.at(-1)).toMatchObject({
        method: "chat.fallback.runManualRung",
        variables: {
          rung: "retry",
          target: null,
          userMessageId: ATTEMPT_MESSAGE_ID,
          turnId: ATTEMPT_TURN_ID,
        },
      });
    });

    it("Wait dispatches wait_once with no target, and names when it ends", async () => {
      mount(failedTurn(["retry", "switch", "wait_once"]));
      await open();

      fireEvent.click(
        option(new RegExp(`Wait until ${formatClockTime(RESETS_AT)}`)),
      );
      expect(footerConfirm().textContent).toContain("Wait");
      expect(
        screen.getByText(
          `Waits until ${formatClockTime(RESETS_AT)}, then runs this message on the same account and model.`,
        ),
      ).toBeDefined();
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toEqual([
        {
          clientId: TAB_CLIENT_ID,
          method: "chat.fallback.runManualRung",
          variables: {
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            rung: "wait_once",
            target: null,
            userMessageId: ATTEMPT_MESSAGE_ID,
            turnId: ATTEMPT_TURN_ID,
          },
        },
      ]);
    });

    it("moving the store after staging Retry replaces the staged action: the confirm is a Switch again", async () => {
      mount(failedTurn(["retry", "switch"]));
      await open();
      fireEvent.click(option(/Try Personal again/));
      expect(footerConfirm().textContent).toContain("Retry");

      fireEvent.click(option(/Claude Opus 4/));

      expect(footerConfirm().textContent).toContain("Switch");
      fireEvent.click(footerConfirm());
      expect(kit.mutations.at(-1)).toMatchObject({
        variables: { rung: "switch" },
      });
    });

    it("the countdown offers Retry and Wait from the session's live failed attempt, and dispatches them without waiting for the hold", async () => {
      session.setState({
        lastFailedAttempt: failedAttempt(["retry", "wait_once"]),
      });
      kit.lease = null;
      mount(countdownAt(HOLD_PENDING));
      await open();

      fireEvent.click(option(/Try Personal again/));
      // Not a switch: the token and the frozen window are no part of it.
      expect(footerConfirm().disabled).toBe(false);
      fireEvent.click(footerConfirm());

      expect(kit.mutations.at(-1)).toMatchObject({
        method: "chat.fallback.runManualRung",
        variables: { rung: "retry", target: null },
      });
    });

    it("the waiting card offers neither Retry nor Wait - it IS the wait", async () => {
      session.setState({
        lastFailedAttempt: failedAttempt(["retry", "wait_once"]),
      });
      mount(waiting());
      await open();

      expect(screen.queryByRole("option", { name: /again/ })).toBeNull();
      expect(screen.queryByRole("option", { name: /Wait until/ })).toBeNull();
    });
  });

  describe("where an answer goes", () => {
    it("a refusal prints inline in the chooser, the chooser stays open, and nothing toasts or reaches the announcer", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain("Couldn't switch just now.");
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
      expect(kit.toast).not.toHaveBeenCalled();
      expect(kit.unattended).toEqual([]);
    });

    it("rung_target_unavailable prints inline AND dims the row that was sent, with a note, for the rest of the open", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "rung_target_unavailable", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain(
        "That destination isn't available right now.",
      );
      const dimmed = option(/Codex · Codex Team/);
      expect(dimmed.getAttribute("aria-disabled")).toBe("true");
      expect(dimmed.textContent).toContain("Not available right now.");
      // Another row is untouched.
      expect(option(/^Work/).getAttribute("aria-disabled")).toBe("false");
    });

    it("a refusal is cleared by the next attempt, not left beside a fresh answer", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());
      expect(statusLines()).toContain("Couldn't switch just now.");

      kit.mutationResult = { outcome: "attempt_not_latest", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).not.toContain("Couldn't switch just now.");
      expect(statusLines()).toContain(
        "This chat has moved on since that message. Send a new message to continue.",
      );
    });

    it("a transport failure prints the unreachable line and leaves the chooser open", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationFails = true;
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain(
        "Couldn't reach this chat's host just now.",
      );
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
      expect(footerConfirm().disabled).toBe(false);
    });

    it("applied closes the chooser and prints nothing", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "applied", detail: null };
      fireEvent.click(footerConfirm());

      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      expect(kit.toast).not.toHaveBeenCalled();
    });

    it("a refused Retry answers inline while the chooser is open - the announcer is for a chooser that has gone", async () => {
      mount(failedTurn(["retry", "switch"]));
      await open();
      fireEvent.click(option(/Try Personal again/));
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain("Couldn't retry just now.");
      expect(kit.toast).not.toHaveBeenCalled();
      expect(kit.unattended).toEqual([]);
    });
  });

  describe("what a refused manual rung says", () => {
    async function sendSwitchRefusedWith(
      outcome: string,
      detail: { kind: string; label: string; retryable: boolean } | null,
    ): Promise<void> {
      mount(failedTurn(["retry", "switch"]));
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome, detail };
      fireEvent.click(footerConfirm());
    }

    it("(a) an error-row switch refused with a detail prints the card's own sentence, the host's name included", async () => {
      const detail = {
        kind: "worktree_missing",
        label: "The worktree is gone.",
        retryable: false,
      };
      await sendSwitchRefusedWith("rung_unavailable", detail);

      const expected = describeManualRungRefusal({
        outcome: "rung_unavailable",
        detail,
        rung: "switch",
        hostLabel: "Session host",
      })?.text;
      expect(expected).toBe(
        "This chat's worktree no longer exists on Session host. Start a new chat from this task.",
      );
      expect(statusLines()).toContain(expected);
      expect(kit.toast).not.toHaveBeenCalled();
    });

    it("(b) a staged Retry refused with no detail prints the neutral sentence for retry", async () => {
      mount(failedTurn(["retry", "switch"]));
      await open();
      fireEvent.click(option(/Try Personal again/));
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain("Couldn't retry just now.");
    });

    it("(c) a refusal whose copy has no text leaves the refusal region empty, and the chooser open", async () => {
      // `routing_active` is the silent kind: the routing card on screen is
      // its explanation.
      await sendSwitchRefusedWith("rung_unavailable", {
        kind: "routing_active",
        label: "Routing is active.",
        retryable: false,
      });

      expect(
        describeManualRungRefusal({
          outcome: "rung_unavailable",
          detail: {
            kind: "routing_active",
            label: "Routing is active.",
            retryable: false,
          },
          rung: "switch",
          hostLabel: "Session host",
        })?.text,
      ).toBeNull();
      // Only the announcer's row count is left: the refusal region is empty.
      expect(statusLines()).toEqual(["3 suggested destinations available."]);
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
    });

    it("(d) a chooseTarget refusal still shows the outcome sentence", async () => {
      mount(waiting());
      await open();
      fireEvent.click(option(/Codex · Codex Team/));
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain(
        describeFallbackOutcome("traversal_advanced"),
      );
    });

    it("(e) rung_target_unavailable on the error-row switch prints the host's sentence and still dims the row that was sent", async () => {
      await sendSwitchRefusedWith("rung_target_unavailable", {
        kind: "target_unusable",
        label: "unused",
        retryable: false,
      });

      expect(statusLines()).toContain(
        "That model can't be used right now. Pick another.",
      );
      const dimmed = option(/Codex · Codex Team/);
      expect(dimmed.getAttribute("aria-disabled")).toBe("true");
      expect(dimmed.textContent).toContain("Not available right now.");
    });
  });

  describe("the trigger", () => {
    it("renders a ReactNode label inside the trigger button", () => {
      mountTrigger(failedTurn(["switch"]), {
        label: (
          <span data-testid="label-node">
            <svg aria-hidden="true" data-testid="label-icon" />
            Route
          </span>
        ),
        ariaLabel: null,
        variant: "outline",
      });

      const button = screen.getByRole("button", { name: "Route" });
      expect(within(button).getByTestId("label-node")).toBeDefined();
      expect(within(button).getByTestId("label-icon")).toBeDefined();
    });

    it("names the trigger by triggerAriaLabel when given, and by its content when null", () => {
      const view = mountTrigger(failedTurn(["switch"]), {
        label: "Route",
        ariaLabel: "Change destination: Claude Sonnet 4",
        variant: "outline",
      });
      expect(
        screen.getByRole("button", {
          name: "Change destination: Claude Sonnet 4",
        }),
      ).toBeDefined();
      expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
      view.unmount();

      mountTrigger(failedTurn(["switch"]), {
        label: "Route",
        ariaLabel: null,
        variant: "outline",
      });
      expect(screen.getByRole("button", { name: "Route" })).toBeDefined();
    });

    it("gives the route-chip variant the route-chip size and every other variant size sm", () => {
      const chip = mountTrigger(failedTurn(["switch"]), {
        label: "Route",
        ariaLabel: null,
        variant: "route-chip",
      });
      let button = screen.getByRole("button", { name: "Route" });
      expect(button.getAttribute("data-variant")).toBe("route-chip");
      expect(button.getAttribute("data-size")).toBe("route-chip");
      chip.unmount();

      const outline = mountTrigger(failedTurn(["switch"]), {
        label: "Route",
        ariaLabel: null,
        variant: "outline",
      });
      button = screen.getByRole("button", { name: "Route" });
      expect(button.getAttribute("data-variant")).toBe("outline");
      expect(button.getAttribute("data-size")).toBe("sm");
      outline.unmount();

      mountTrigger(failedTurn(["switch"]), {
        label: "Route",
        ariaLabel: null,
        variant: "default",
      });
      button = screen.getByRole("button", { name: "Route" });
      expect(button.getAttribute("data-size")).toBe("sm");
    });
  });

  describe("usage probes", () => {
    it("asks each suggested (provider, account) pair for fresh usage once per open - across two providers - and not again on re-render", async () => {
      const view = mount(failedTurn(["retry", "switch"]));
      await open();

      const asked = kit.ensureFreshCalls.map(
        (call) => `${call.providerId}|${call.profileId}`,
      );
      // Claude: the sibling account and the account that failed (the Retry
      // row); Codex: the equivalent model's account.
      expect(new Set(asked)).toEqual(
        new Set([
          `claude-code|${WORK_PROFILE}`,
          `claude-code|${FAILED_PROFILE}`,
          `codex|${TARGET.profileId}`,
        ]),
      );
      expect(asked).toHaveLength(3);

      view.rerenderWith(failedTurn(["retry", "switch"]));
      view.rerenderWith(failedTurn(["retry", "switch"]));
      act(() => {
        kit.usage.set(`claude-code|${WORK_PROFILE}`, {
          detail: { kind: "semantic-only", status: "near_limit" },
          fetchEligible: true,
          refreshStatus: "idle",
        });
      });
      view.rerenderWith(failedTurn(["retry", "switch"]));

      expect(kit.ensureFreshCalls).toHaveLength(3);
    });

    it("asks again on the next open", async () => {
      mount(failedTurn(["switch"]));
      const dialog = await open();
      const firstOpen = kit.ensureFreshCalls.length;
      expect(firstOpen).toBeGreaterThan(0);
      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });

      await open();

      expect(kit.ensureFreshCalls.length).toBe(firstOpen * 2);
    });

    it("mounts no probe while closed", () => {
      mount(failedTurn(["switch"]));

      expect(kit.usageProbeCalls).toEqual([]);
      expect(kit.ensureFreshCalls).toEqual([]);
    });
  });

  describe("the preselect", () => {
    it("commits the recommended selectable switch row on the first fresh listing, so the confirm can send it", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();

      expect(lastStore().getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "claude-sonnet-4",
        profileId: WORK_PROFILE,
      });
      expect(footerConfirm().disabled).toBe(false);
      expect(option(/^Work/).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(footerConfirm());
      expect(kit.mutations[0].variables.target).toEqual({
        ...FAILED,
        profileId: WORK_PROFILE,
      });
    });

    it("waits for a settled listing: a listing still refetching preselects nothing", async () => {
      kit.listData = listing({ recommendedWork: true });
      kit.listFetching = true;
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);

      kit.listFetching = false;
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection.profileId).toBe(WORK_PROFILE);
    });

    it("leaves a pick the user already made alone", async () => {
      kit.listData = listing({ recommendedWork: true });
      kit.listFetching = true;
      const view = mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));

      kit.listFetching = false;
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection.modelSlug).toBe("claude-opus-4");
      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
    });

    it("a query that hides the section reverts the preselect to the failed tuple, and the confirm goes quiet", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();
      expect(lastStore().getState().selection.profileId).toBe(WORK_PROFILE);

      fireEvent.change(screen.getByRole("textbox", { name: /^Search/ }), {
        target: { value: "opus" },
      });

      expect(lastStore().getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "claude-sonnet-4",
        profileId: FAILED_PROFILE,
      });
      expect(footerConfirm().disabled).toBe(true);
    });

    it("a query typed before the listing arrives cancels the preselect for the rest of that open - the listing landing later, and the query clearing, move nothing", async () => {
      kit.listData = undefined;
      const view = mount(failedTurn(["switch"]));
      await open();
      fireEvent.change(screen.getByRole("textbox", { name: /^Search/ }), {
        target: { value: "opus" },
      });

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(failedTurn(["switch"]));
      expect(lastStore().getState().selection).toEqual({
        harnessId: FAILED.harnessId,
        modelSlug: FAILED.model,
        profileId: FAILED_PROFILE,
      });
      expect(footerConfirm().disabled).toBe(true);

      fireEvent.change(screen.getByRole("textbox", { name: /^Search/ }), {
        target: { value: "" },
      });
      // Nothing on screen offered the row while the query hid the section, so
      // committing it now would enable Switch for a destination nobody chose.
      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
      expect(footerConfirm().disabled).toBe(true);
    });

    it("preselects the one usable model row when no sibling account is usable, so Switch is enabled and confirm sends its host target", async () => {
      kit.listData = {
        ...listing({ recommendedWork: false }),
        profileTargets: [],
      };
      mount(failedTurn(["switch"]));
      await open();

      expect(lastStore().getState().selection).toEqual({
        harnessId: "codex",
        modelSlug: TARGET.model,
        profileId: TARGET.profileId,
      });
      expect(footerConfirm().disabled).toBe(false);
      fireEvent.click(footerConfirm());
      expect(kit.mutations[0].variables.target).toEqual(TARGET);
    });

    it("R2-3b: a preselect that commits a same-model row with no effort resets a stale raw effort, so the row is checked and its null-effort target is sent", async () => {
      const seed: ChatRunSettings = {
        ...HAIKU_SEED,
        reasoningEffort: "low",
      };
      const rowTarget: ChatRunSettings = {
        ...seed,
        profileId: WORK_PROFILE,
        reasoningEffort: null,
      };
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: seed,
        profileTargets: [],
        modelTargets: [
          haikuModelRow({ groupId: "grp-same-pair", target: rowTarget }),
        ],
        modelTargetsSkip: null,
      });
      mount(haikuEntry(seed));
      await open();

      expect(lastStore().getState().values.reasoning).toBe("");
      expect(lastStore().getState().reasoning).toBe("high");
      expect(suggested()[0].getAttribute("aria-selected")).toBe("true");
      expect(footerConfirm().disabled).toBe(false);

      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0].variables.target).toEqual(rowTarget);
      expect(kit.mutations[0].variables).toMatchObject({
        target: { reasoningEffort: null },
      });
    });

    it("a query does NOT revert a pick the user made after the preselect", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));

      fireEvent.change(screen.getByRole("textbox", { name: /^Search/ }), {
        target: { value: "opus" },
      });

      expect(lastStore().getState().selection.modelSlug).toBe("claude-opus-4");
    });
  });

  describe("an empty listing", () => {
    it("names the chat, offers every model below, and has a button that opens model routing settings", async () => {
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: FAILED,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount(failedTurn(["switch"]));
      await open();

      expect(
        screen.getByText(
          "No other model is set up for Claude Code · claude-sonnet-4. Pick any model below, or set up routing in Settings",
        ),
      ).toBeDefined();
      // Any model below is still pickable.
      expect(option(/Claude Opus 4/)).toBeDefined();

      fireEvent.click(
        screen.getByRole("button", { name: "Open model routing settings" }),
      );
      expect(kit.openSettings).toHaveBeenCalledTimes(1);
    });
  });
});
