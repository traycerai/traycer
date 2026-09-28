import {
  act,
  cleanup,
  fireEvent,
  render,
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
import { createRef } from "react";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  RoutingDestinationPicker,
  type RoutingDestinationEntry,
} from "@/components/chat/fallback/routing-destination-picker";
import {
  HarnessModelPicker,
  type HarnessModelPickerEmbedding,
} from "@/components/home/pickers/harness-model-picker";
import { DEFAULT_PERMISSION } from "@/components/home/data/landing-options";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  FallbackModelTarget,
  FallbackProfileTarget,
} from "@traycer/protocol/host/chat-fallback";
import {
  describeFallbackOutcome,
  describeManualRungRefusal,
} from "@/components/chat/fallback/fallback-copy";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import {
  APP_WIDE_CLIENT_ID,
  CHAT_ID,
  EPIC_ID,
  SESSION_HOST_ID,
  TAB_CLIENT_ID,
  TAB_HOST_ID,
  TRAVERSAL_ID,
  heldLease,
  kit,
  resetKit,
} from "./routing-picker-kit";
import {
  ATTEMPT_MESSAGE_ID,
  ATTEMPT_TURN_ID,
  CHOOSING_PENDING,
  FAILED,
  FAILED_PROFILE,
  HOLD_PENDING,
  TARGET,
  WORK_PROFILE,
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
  fallbackSkip,
  listTargetsResponse,
} from "./fallback-fixtures";

/**
 * The routing chooser as a unit: the composer's model picker with one footer
 * line and one Switch. The picker's own behaviour is pinned in
 * `home/__tests__/harness-model-picker.test.tsx`, and the hold against the
 * REAL session store in `routing-destination-picker-lease-integration.test.tsx`.
 * This file is what the wrapper alone owns: the store it never lets write, the
 * host every read goes to, the recommendation it opens on, the hold, the
 * footer, what a confirm sends, and where each answer goes.
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

const PICKER_BODY_HEIGHT =
  "h-[min(var(--radix-popover-content-available-height),23rem)]";

/** A listing naming `profileTargets` and `modelTargets` for the failed tuple. */
function listingOf(input: {
  readonly failedTuple: ChatRunSettings;
  readonly profileTargets: ReadonlyArray<FallbackProfileTarget>;
  readonly modelTargets: ReadonlyArray<FallbackModelTarget>;
}) {
  return listTargetsResponse({
    outcome: "listed",
    failedTuple: input.failedTuple,
    profileTargets: [...input.profileTargets],
    modelTargets: [...input.modelTargets],
    modelTargetsSkip: null,
  });
}

function accountTarget(input: {
  readonly profileId: string;
  readonly recommended: boolean;
  readonly selectable: boolean;
  readonly rateLimited: boolean;
}) {
  return fallbackProfileTarget({
    profileId: input.profileId,
    label: input.profileId,
    severity: "ok",
    usedPercent: 10,
    recommended: input.recommended,
    selectable: input.selectable,
    skip: input.rateLimited
      ? fallbackSkip({ reason: "rate-limited", label: "Limit reached" })
      : null,
  });
}

/** One equivalent-model destination whose host-built target is `target`. */
function modelTargetOf(input: {
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

/** A listing for the haiku seed, with the Work account recommended or not. */
function haikuListing(input: { readonly recommendedWork: boolean }) {
  return listingOf({
    failedTuple: HAIKU_SEED,
    profileTargets: [
      accountTarget({
        profileId: WORK_PROFILE,
        recommended: input.recommendedWork,
        selectable: true,
        rateLimited: false,
      }),
    ],
    modelTargets: [],
  });
}

/** The footer's one line, whole. */
function footerLine(): string {
  return screen.getByText(/^Replays on /).textContent;
}

/** The picker's effort control, in its list form: a button per level. */
async function chooseEffort(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name }));
}

/** The chooser's Codex catalog row: reached through the rail, never a Suggested row. */
function catalogGpt5(): HTMLElement {
  fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
  return option(/GPT-5/);
}

/**
 * Runs `fn` with React's act environment OFF, so an update is scheduled the way
 * production schedules it - a sync lane in a microtask, a default lane in a
 * later task - rather than drained before `act` returns. Testing Library's own
 * helpers (`fireEvent`, `rerender`) open an `act` scope whatever this flag
 * says, so `fn` must drive the DOM natively.
 */
async function withActEnvironmentDisabled(
  fn: () => Promise<void>,
): Promise<void> {
  const globalWithActFlag = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
  globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
  } finally {
    globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previous;
  }
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
      mount(failedTurn(["switch"]));
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
    it("pushes the catalog, reads the providers, lists targets and sends the verb through the tab client, never the app-wide one", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
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
      expect(kit.mutations.map((call) => call.clientId)).toEqual([
        TAB_CLIENT_ID,
      ]);
    });

    it("reads the listing while closed for a reader who can act, and never for one who cannot", () => {
      mount(failedTurn(["switch"]));
      expect(
        kit.listCalls.filter((call) => call.enabled).length,
      ).toBeGreaterThan(0);
      cleanup();

      kit.listCalls = [];
      mountAs(failedTurn(["switch"]), false);
      expect(kit.listCalls.filter((call) => call.enabled)).toEqual([]);
    });

    it("asks for the listing again on every open", async () => {
      mount(failedTurn(["switch"]));
      expect(kit.refetchCalls).toBe(0);

      const dialog = await open();
      expect(kit.refetchCalls).toBe(1);
      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      await open();

      expect(kit.refetchCalls).toBe(2);
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

    it("releases once on unmount while open - the wrapper's own cleanup and the picker's unmount close report pay one hold", async () => {
      kit.lease = heldLease("held", "tok-1");
      const view = mount(countdown());
      await open();
      expect(kit.release).not.toHaveBeenCalled();

      view.unmount();
      // Both paths fire on this unmount; the count is what guards the double.

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
      fireEvent.click(option(/Claude Opus 4/));
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
      fireEvent.click(option(/Claude Opus 4/));
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
      fireEvent.click(option(/Claude Opus 4/));
      expect(footerConfirm().disabled).toBe(true);
    });
  });

  describe("the preselect: the chooser opens on the recommendation", () => {
    it("has the store on the recommended account before the popover is opened, and opens on it", async () => {
      kit.listData = undefined;
      const view = mount(failedTurn(["switch"]));
      // The listing lands while the chooser is still closed.
      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection).toEqual({
        harnessId: FAILED.harnessId,
        modelSlug: FAILED.model,
        profileId: WORK_PROFILE,
      });
      await open();

      expect(lastStore().getState().selection.profileId).toBe(WORK_PROFILE);
      expect(footerConfirm().disabled).toBe(false);
      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
    });

    it("opens on the failed tuple with Switch disabled when the host recommends no account", async () => {
      kit.listData = listing({ recommendedWork: false });
      mount(failedTurn(["switch"]));
      await open();

      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
      expect(footerConfirm().disabled).toBe(true);
    });

    it("does not open on a recommended account that is rate-limited or not selectable", async () => {
      for (const flags of [
        { selectable: true, rateLimited: true },
        { selectable: false, rateLimited: false },
      ]) {
        kit.listData = listingOf({
          failedTuple: FAILED,
          profileTargets: [
            accountTarget({
              profileId: WORK_PROFILE,
              recommended: true,
              ...flags,
            }),
          ],
          modelTargets: [],
        });
        mount(failedTurn(["switch"]));
        await open();

        expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
        expect(footerConfirm().disabled).toBe(true);
        cleanup();
      }
    });

    it("builds the recommended account's tuple from the entry's own tuple when the listing came back with no failed tuple", async () => {
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: null,
        profileTargets: [
          accountTarget({
            profileId: WORK_PROFILE,
            recommended: true,
            selectable: true,
            rateLimited: false,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        variables: { target: { ...FAILED, profileId: WORK_PROFILE } },
      });
    });

    it("falls back to the failed tuple for an outcome that lists nothing, and Switch stays available from the catalog", async () => {
      kit.listData = listTargetsResponse({
        outcome: "state_unreadable",
        failedTuple: null,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount(failedTurn(["switch"]));
      await open();
      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
      expect(footerConfirm().disabled).toBe(true);

      fireEvent.click(option(/Claude Opus 4/));
      expect(footerConfirm().disabled).toBe(false);
    });

    it("an untouched store follows a changed recommendation while the chooser is open", async () => {
      kit.listData = listing({ recommendedWork: true });
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(lastStore().getState().selection.profileId).toBe(WORK_PROFILE);

      kit.listData = listingOf({
        failedTuple: FAILED,
        profileTargets: [
          accountTarget({
            profileId: "moved-recommendation",
            recommended: true,
            selectable: true,
            rateLimited: false,
          }),
        ],
        modelTargets: [],
      });
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection.profileId).toBe(
        "moved-recommendation",
      );
    });

    it("a pick the user made is theirs: a later listing moves nothing", async () => {
      kit.listData = listing({ recommendedWork: false });
      const view = mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "claude-opus-4",
        profileId: FAILED_PROFILE,
      });
    });

    it("an effort-only edit is the user's choice: a later listing moves neither the account nor the effort", async () => {
      useLayoutStore.getState().setComposerReasoningFooterControl("list");
      kit.listData = haikuListing({ recommendedWork: false });
      const view = mount(haikuEntry(HAIKU_SEED));
      await open();
      await chooseEffort("Low");
      expect(lastStore().getState().values.reasoning).toBe("low");

      kit.listData = haikuListing({ recommendedWork: true });
      view.rerenderWith(haikuEntry(HAIKU_SEED));

      expect(lastStore().getState().values.selection.profileId).toBe(
        FAILED_PROFILE,
      );
      expect(lastStore().getState().values.reasoning).toBe("low");
    });

    it("a pick walked back to the failed tuple is still the user's: a later listing does not move it", async () => {
      kit.listData = listing({ recommendedWork: false });
      const view = mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(option(/Claude Sonnet 4/));
      expect(lastStore().getState().selection).toEqual({
        harnessId: FAILED.harnessId,
        modelSlug: FAILED.model,
        profileId: FAILED_PROFILE,
      });

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(failedTurn(["switch"]));

      expect(lastStore().getState().selection.profileId).toBe(FAILED_PROFILE);
    });

    it("an edit abandoned by closing does not survive: the next open is back on the current recommendation", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      const dialog = await open();
      fireEvent.click(option(/Claude Opus 4/));
      expect(lastStore().getState().selection.modelSlug).toBe("claude-opus-4");

      fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      await open();

      expect(lastStore().getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "claude-sonnet-4",
        profileId: WORK_PROFILE,
      });
    });
  });

  describe("the footer", () => {
    it("says where Switch replays the message, for the preselected account", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();

      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
    });

    it("moves with a pick: another model, then another provider", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      expect(footerLine()).toBe(
        "Replays on Claude Opus 4 · Work in a new session",
      );

      fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
      fireEvent.click(option(/GPT-4\.1/));
      expect(footerLine()).toMatch(
        /^Replays on GPT-4\.1 · .+ in a new session$/,
      );
    });

    it("a refusal replaces the line and is in the live region", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());

      expect(screen.getByRole("status").textContent).toBe(
        "Couldn't switch just now.",
      );
      expect(screen.queryByText(/^Replays on /)).toBeNull();
      expect(screen.getAllByText("Couldn't switch just now.")).toHaveLength(2);
    });

    it("keeps the live region present and empty when there is nothing to say", async () => {
      mount(failedTurn(["switch"]));
      await open();

      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");
      expect(region.className).toContain("sr-only");
    });

    it("has exactly one button, Switch, and no Retry, Wait or Suggested anywhere in the popover", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["retry", "switch", "wait_once"]));
      const dialog = await open();

      const slot = dialog.querySelector("[data-picker-embedding-footer]");
      if (!(slot instanceof HTMLElement)) throw new Error("no footer slot");
      const buttons = within(slot).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["Switch"]);
      expect(within(dialog).queryByText(/Retry/)).toBeNull();
      expect(within(dialog).queryByText(/Wait/)).toBeNull();
      expect(within(dialog).queryByText(/Suggested/)).toBeNull();
    });

    it("keeps the footer outside the body that carries the list's height, and the popover only capped (structural: jsdom does no layout)", async () => {
      mount(failedTurn(["switch"]));
      const dialog = await open();

      const footer = dialog.querySelector("[data-picker-embedding-footer]");
      expect(footer).not.toBeNull();
      const body = dialog.querySelector(`[class*="${PICKER_BODY_HEIGHT}"]`);
      expect(body).not.toBeNull();
      expect(body?.contains(footer)).toBe(false);
      expect(body?.contains(within(dialog).getByRole("listbox"))).toBe(true);
      expect(dialog.className).not.toContain(PICKER_BODY_HEIGHT);
      expect(dialog.className).toContain(
        "max-h-[var(--radix-popover-content-available-height)]",
      );
    });
  });

  describe("the confirm", () => {
    it("is disabled on a countdown switch until the lease is held AND the frame says choosing", async () => {
      kit.lease = null;
      const view = mount(countdownAt(HOLD_PENDING));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      expect(footerConfirm().disabled).toBe(true);

      // Held, but the frame still runs the countdown: not yet.
      kit.lease = heldLease("held", "tok-1");
      view.rerenderWith(countdownAt(HOLD_PENDING));
      expect(footerConfirm().disabled).toBe(true);

      // Choosing but no token: still not.
      kit.lease = heldLease("pending", null);
      view.rerenderWith(countdownAt(CHOOSING_PENDING));
      expect(footerConfirm().disabled).toBe(true);

      // Both halves.
      kit.lease = heldLease("held", "tok-1");
      view.rerenderWith(countdownAt({ ...CHOOSING_PENDING, revision: 3 }));
      expect(footerConfirm().disabled).toBe(false);
    });

    it("is disabled while nothing has moved, and for a viewer who cannot act", async () => {
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(footerConfirm().disabled).toBe(true);

      fireEvent.click(option(/Claude Opus 4/));
      expect(footerConfirm().disabled).toBe(false);
      view.unmount();

      mountAs(failedTurn(["switch"]), false);
      // The trigger goes quiet for a viewer, so the chooser cannot be opened
      // from it at all.
      expect(
        screen.getByRole("button", { name: "Choose differently…" }),
      ).toHaveProperty("disabled", true);
    });

    it("is disabled while a send is in flight, and a second click sends nothing", async () => {
      kit.deferResponses = true;
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(footerConfirm().disabled).toBe(true);
      expect(kit.mutations).toHaveLength(1);
      fireEvent.click(footerConfirm());
      expect(kit.mutations).toHaveLength(1);
    });

    it("Enter on the focused footer Switch is the button's own activation: one send, the picked target, and the list's active row is not selected by it", async () => {
      kit.lease = heldLease("held", "tok-1");
      // A refusal keeps the chooser open (an applied answer would close it and
      // drop the pick), so the store can be read after the Enter.
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      mount(countdown());
      const dialog = await open();
      fireEvent.click(option(/Claude Opus 4/));
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
        variables: {
          target: { ...FAILED, model: "claude-opus-4" },
          leaseToken: "tok-1",
        },
      });
      expect(lastStore().getState().selection).toEqual(picked);
    });

    it("Space on the focused footer Switch sends once too, and moves no row (guard: the list never handled Space)", async () => {
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      mount(failedTurn(["switch"]));
      const dialog = await open();
      fireEvent.click(option(/Claude Opus 4/));
      const picked = lastStore().getState().selection;
      fireEvent.keyDown(within(dialog).getByRole("textbox"), {
        key: "ArrowDown",
      });

      act(() => {
        footerConfirm().focus();
      });
      await userEvent.keyboard(" ");

      expect(kit.mutations).toHaveLength(1);
      expect(lastStore().getState().selection).toEqual(picked);
    });
  });

  describe("what a confirm sends", () => {
    it("a pick that is one of the listing's model destinations sends its host-built target unchanged, over the countdown, with the lease token", async () => {
      // A host target the client branch could not have produced: a different
      // permission mode, and a service tier. The client branch keeps the FAILED
      // tuple's permission mode (`auto_accept_edits`) and nulls a tier the
      // picked model does not offer (the kit's Codex model offers none), so a
      // send that rebuilt the tuple would come out with both fields wrong.
      const hostTarget: ChatRunSettings = {
        ...TARGET,
        profileId: null,
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingOf({
        failedTuple: FAILED,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-a", target: hostTarget })],
      });
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(catalogGpt5());
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
      expect(kit.mutations[0]).toMatchObject({
        variables: {
          target: { permissionMode: "full_access", serviceTier: "fast" },
        },
      });
    });

    it("an explicit-effort destination is matched by a plain pick that resolves to that effort: the model's default equals it", async () => {
      // gpt-5 advertises low/medium/high and no default, so a plain pick
      // resolves to "low" - the destination's own.
      const hostTarget: ChatRunSettings = {
        ...TARGET,
        profileId: null,
        reasoningEffort: "low",
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingOf({
        failedTuple: FAILED,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-a", target: hostTarget })],
      });
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(catalogGpt5());
      expect(lastStore().getState().values.reasoning).toBe("");
      expect(lastStore().getState().reasoning).toBe("low");
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        variables: { target: hostTarget },
      });
    });

    it("the same for a real explicit model default: a claude-haiku-4 destination at its default 'high', reached from another model by plain clicks", async () => {
      const hostTarget: ChatRunSettings = {
        ...FAILED,
        model: "claude-haiku-4",
        reasoningEffort: "high",
        permissionMode: "full_access",
        serviceTier: "fast",
      };
      kit.listData = listingOf({
        failedTuple: FAILED,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-h", target: hostTarget })],
      });
      kit.lease = heldLease("held", "tok-1");
      mount(countdown());
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(option(/Claude Haiku 4/));
      expect(lastStore().getState().reasoning).toBe("high");
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        variables: { target: hostTarget },
      });
    });

    it("a null-effort destination is matched by the model's default, and an effort chosen away from it sends the CLIENT tuple", async () => {
      useLayoutStore.getState().setComposerReasoningFooterControl("list");
      const hostTarget: ChatRunSettings = {
        ...HAIKU_SEED,
        reasoningEffort: null,
        permissionMode: "full_access",
      };
      kit.listData = listingOf({
        failedTuple: HAIKU_SEED,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-h", target: hostTarget })],
      });
      mount(haikuEntry(HAIKU_SEED));
      await open();
      // The seed is haiku at the model default; nothing moved yet.
      expect(footerConfirm().disabled).toBe(true);

      await chooseEffort("Low");
      expect(footerConfirm().disabled).toBe(false);
      fireEvent.click(footerConfirm());

      // "low" is not the destination's effective effort ("high"), so the
      // client tuple goes, over the FAILED tuple's own permission mode.
      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        variables: {
          target: { ...HAIKU_SEED, reasoningEffort: "low" },
        },
      });
      expect(kit.mutations[0]).not.toMatchObject({
        variables: { target: { permissionMode: "full_access" } },
      });
    });

    it("the recommended account, untouched, sends the failed tuple with only the account swapped", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      await open();

      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        method: "chat.fallback.runManualRung",
        variables: { target: { ...FAILED, profileId: WORK_PROFILE } },
      });
    });

    it("a pick that is not a listed destination sends a client tuple over the failed tuple, keeping its permission and agent mode and clamping fast mode the model does not offer", async () => {
      // The failed tuple was running fast mode; Claude Opus 4 offers no tier.
      const fastFailed: ChatRunSettings = { ...FAILED, serviceTier: "fast" };
      kit.lease = heldLease("held", "tok-1");
      mount({
        kind: "failed-turn",
        attempt: failedAttempt(["switch"]),
        seedTuple: fastFailed,
      });
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        variables: {
          target: {
            ...FAILED,
            harnessId: "claude",
            model: "claude-opus-4",
            profileId: FAILED_PROFILE,
            reasoningEffort: null,
            serviceTier: null,
          },
        },
      });
    });

    it("the waiting card sends chooseTarget with no lease token at all", async () => {
      mount(waiting());
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toHaveLength(1);
      expect(kit.mutations[0]).toMatchObject({
        method: "chat.fallback.chooseTarget",
        variables: {
          traversalId: TRAVERSAL_ID,
          revision: 3,
          leaseToken: null,
        },
      });
    });

    it("the error row sends runManualRung switch bound to BOTH ids of the attempt", async () => {
      mount(failedTurn(["switch"]));
      await open();

      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.mutations).toEqual([
        {
          clientId: TAB_CLIENT_ID,
          method: "chat.fallback.runManualRung",
          variables: {
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            rung: "switch",
            target: { ...FAILED, model: "claude-opus-4" },
            userMessageId: ATTEMPT_MESSAGE_ID,
            turnId: ATTEMPT_TURN_ID,
          },
        },
      ]);
    });

    it("the answer to a pick made after the chooser has gone is spoken on the chat's announcer, not inline (MF11)", async () => {
      kit.deferResponses = true;
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      const view = mount(waiting());
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());
      expect(kit.pendingResponses).toHaveLength(1);

      // The parent unmounts the chooser (the waiting card became the switching
      // card) with the answer still outstanding.
      view.unmount();
      act(() => {
        kit.pendingResponses[0]();
      });

      expect(kit.unattended).toEqual([
        {
          hostId: "host-session",
          epicId: "epic-routing",
          chatId: "chat-routing",
          text: "This chat already resumed.",
        },
      ]);
      expect(kit.toast).not.toHaveBeenCalled();
    });

    it("a confirmed switch is recorded for the announcer whether or not the chooser is still there", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      fireEvent.click(footerConfirm());

      expect(kit.confirmed).toEqual([
        {
          hostId: "host-session",
          epicId: "epic-routing",
          chatId: "chat-routing",
          rung: "switch",
          userMessageId: ATTEMPT_MESSAGE_ID,
          turnId: ATTEMPT_TURN_ID,
          target: { ...FAILED, model: "claude-opus-4" },
        },
      ]);
    });
  });

  describe("where an answer goes", () => {
    async function sendSwitchRefusedWith(
      outcome: string,
      detail: { kind: string; label: string; retryable: boolean } | null,
    ): Promise<void> {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      kit.mutationResult = { outcome, detail };
      fireEvent.click(footerConfirm());
    }

    it("a refusal prints inline in the chooser, the chooser stays open, and nothing toasts or reaches the announcer", async () => {
      await sendSwitchRefusedWith("rung_unavailable", null);

      expect(statusLines()).toContain("Couldn't switch just now.");
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
      expect(kit.toast).not.toHaveBeenCalled();
      expect(kit.unattended).toEqual([]);
    });

    it("a refusal is cleared by the next attempt, not left beside a fresh answer", async () => {
      await sendSwitchRefusedWith("rung_unavailable", null);
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
      fireEvent.click(option(/Claude Opus 4/));
      kit.mutationFails = true;
      fireEvent.click(footerConfirm());

      expect(statusLines()).toHaveLength(1);
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
    });

    it("applied closes the chooser and prints nothing", async () => {
      mount(failedTurn(["switch"]));
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      kit.mutationResult = { outcome: "applied", detail: null };
      fireEvent.click(footerConfirm());

      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Select model" }),
        ).toBeNull();
      });
      expect(kit.toast).not.toHaveBeenCalled();
      expect(kit.unattended).toEqual([]);
    });

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

    it("(b) a refusal whose copy has no text leaves the refusal region empty, and the chooser open", async () => {
      // `routing_active` is the silent kind: the routing card on screen is
      // its explanation.
      const detail = {
        kind: "routing_active",
        label: "Routing is active.",
        retryable: false,
      };
      await sendSwitchRefusedWith("rung_unavailable", detail);

      expect(
        describeManualRungRefusal({
          outcome: "rung_unavailable",
          detail,
          rung: "switch",
          hostLabel: "Session host",
        })?.text,
      ).toBeNull();
      expect(statusLines()).toEqual([]);
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
    });

    it("(c) a chooseTarget refusal still shows the outcome sentence", async () => {
      mount(waiting());
      await open();
      fireEvent.click(option(/Claude Opus 4/));
      kit.mutationResult = { outcome: "traversal_advanced", detail: null };
      fireEvent.click(footerConfirm());

      expect(statusLines()).toContain(
        describeFallbackOutcome("traversal_advanced"),
      );
    });

    it("(d) rung_target_unavailable on the error-row switch prints the host's sentence and leaves the chooser open", async () => {
      await sendSwitchRefusedWith("rung_target_unavailable", {
        kind: "target_unusable",
        label: "unused",
        retryable: false,
      });

      expect(statusLines()).toContain(
        "That model can't be used right now. Pick another.",
      );
      expect(
        screen.getByRole("dialog", { name: "Select model" }),
      ).toBeDefined();
    });

    /**
     * The chooser's `open` - which the verbs read as `inlineMenuOpen` - hears
     * the picker's visible close from a PASSIVE effect, and an update raised
     * there is demoted to the default lane. Alone, that would leave the chooser
     * rendering `open` for a task after the popover had gone, and an answer
     * landing in that task would go to a footer nobody could see while the
     * announcer stood aside for it.
     *
     * It does not, and this pins why. Every close unmounts the popover's
     * content through Radix's `Presence`, whose layout effect dispatches the
     * unmount on the sync lane. React flushes the close commit's passive
     * effects - the report - before that sync work, and renders the default
     * lane in the same batch, so the chooser's `open` goes false in the one
     * synchronous run that removes the popover. No microtask, and so no answer,
     * runs between them. A Radix or React upgrade that breaks either half
     * turns this red.
     *
     * Testing Library's `fireEvent` is an `act` scope that would drain any gap
     * before returning, so the dismiss is a native event with the act
     * environment off, and the answer lands at the first microtask after the
     * popover leaves the DOM. The Switch is on the untouched recommendation:
     * after an edit the close also drops it, a store write that is a second
     * sync carrier, and this should stand on `Presence` alone.
     */
    it("a refusal answered in the frame that dismissed the chooser is spoken on the announcer", async () => {
      kit.listData = listing({ recommendedWork: true });
      mount(failedTurn(["switch"]));
      const dialog = await open();
      kit.deferResponses = true;
      kit.mutationResult = { outcome: "rung_unavailable", detail: null };
      fireEvent.click(footerConfirm());
      expect(kit.pendingResponses).toHaveLength(1);

      await withActEnvironmentDisabled(async () => {
        within(dialog)
          .getByRole("textbox")
          .dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        for (let turn = 0; turn < 20 && dialog.isConnected; turn += 1) {
          await Promise.resolve();
        }
        // The popover is gone, and no task has run since the dismiss.
        expect(dialog.isConnected).toBe(false);
        kit.pendingResponses[0]();
      });

      await waitFor(() => {
        expect(kit.unattended).toEqual([
          {
            hostId: SESSION_HOST_ID,
            epicId: EPIC_ID,
            chatId: CHAT_ID,
            text: describeManualRungRefusal({
              outcome: "rung_unavailable",
              detail: null,
              rung: "switch",
              hostLabel: null,
            })?.text,
          },
        ]);
      });
      expect(kit.toast).not.toHaveBeenCalled();
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

  describe("the browsed account on a countdown's route chip", () => {
    function chip(entry: RoutingDestinationEntry) {
      return (
        <TooltipProvider>
          <TabHostProvider hostId={TAB_HOST_ID}>
            <RoutingDestinationPicker
              entry={entry}
              triggerLabel="Route"
              triggerVariant="route-chip"
              triggerAriaLabel={null}
              triggerDisabled={false}
              canAct
              epicId={EPIC_ID}
              chatId={CHAT_ID}
              hostId={SESSION_HOST_ID}
            />
          </TabHostProvider>
        </TooltipProvider>
      );
    }

    function mountChip(entry: RoutingDestinationEntry) {
      const result = render(chip(entry));
      return {
        rerenderWith: (next: RoutingDestinationEntry) => {
          result.rerender(chip(next));
        },
      };
    }

    async function openChip(): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: "Route" }));
      await screen.findByRole("dialog", { name: "Select model" });
    }

    /** The profile dropdown's trigger: its aria-label names the account shown. */
    function dropdownName(): string | null {
      return screen
        .getByRole("button", { name: /^Claude profile: / })
        .getAttribute("aria-label");
    }

    /** The chooser's search box, narrowed so `.value` reads with no cast. */
    function searchBox(dialog: HTMLElement): HTMLInputElement {
      const input = within(dialog).getByRole("textbox");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("expected the chooser's search to be an input");
      }
      return input;
    }

    /** The search box's active-descendant id, thrown if there is none. */
    function activeOptionId(input: HTMLInputElement): string {
      const id = input.getAttribute("aria-activedescendant");
      if (id === null) throw new Error("no active descendant");
      return id;
    }

    it("a listing that recommends another account after the open moves the dropdown and the footer together", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      expect(dropdownName()).toBe("Claude profile: Personal");

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());

      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
      expect(dropdownName()).toBe("Claude profile: Work");
      await act(async () => {});
      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
      expect(dropdownName()).toBe("Claude profile: Work");
    });

    it("a listing that named no recommendation at the open, then recommends one, moves the dropdown too", async () => {
      kit.listData = listing({ recommendedWork: false });
      const view = mountChip(countdown());
      await openChip();
      expect(dropdownName()).toBe("Claude profile: Personal");

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());

      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
      expect(dropdownName()).toBe("Claude profile: Work");
    });

    it("a listing answered before the open opens the dropdown and the footer on the recommendation", async () => {
      kit.listData = listing({ recommendedWork: true });
      mountChip(countdown());
      await openChip();

      expect(dropdownName()).toBe("Claude profile: Work");
      expect(footerLine()).toBe(
        "Replays on Claude Sonnet 4 · Work in a new session",
      );
    });

    it("an account the user picked in the dropdown survives a later listing that recommends another", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      await userEvent.click(
        screen.getByRole("button", { name: /^Claude profile: / }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Personal" }),
      );
      expect(dropdownName()).toBe("Claude profile: Personal");

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());
      await act(async () => {});

      expect(dropdownName()).toBe("Claude profile: Personal");
      expect(footerLine()).toMatch(/· Personal in a new session$/);
    });

    it("(A) a typed search survives a late seed: the query and its filtered rows outlast the account move", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });
      const search = searchBox(dialog);

      const allNames = screen
        .getAllByRole("option")
        .map((row) => row.textContent);

      fireEvent.change(search, { target: { value: "opus" } });
      const filteredNames = screen
        .getAllByRole("option")
        .map((row) => row.textContent);
      // Not vacuous: the query actually narrowed the visible set.
      expect(filteredNames.length).toBeGreaterThan(0);
      expect(filteredNames.length).toBeLessThan(allNames.length);
      for (const name of filteredNames) expect(allNames).toContain(name);

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());

      const assertSurvived = (): void => {
        expect(dropdownName()).toBe("Claude profile: Work");
        expect(footerLine()).toBe(
          "Replays on Claude Sonnet 4 · Work in a new session",
        );
        expect(search.value).toBe("opus");
        expect(
          screen.getAllByRole("option").map((row) => row.textContent),
        ).toEqual(filteredNames);
      };
      assertSurvived();
      await act(async () => {});
      assertSurvived();
    });

    it("(B) a keyboard-active row survives a late seed: the arrowed row stays active through the account move", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });
      const search = searchBox(dialog);

      // The default active row (no query) is the currently-selected one,
      // Claude Sonnet 4 - the seed's own model, and also the model the
      // recommendation keeps (only the account moves). One ArrowDown lands on
      // Claude Opus 4, which is neither the current selection nor the row the
      // recommendation will select.
      fireEvent.keyDown(search, { key: "ArrowDown" });
      const activeId = activeOptionId(search);
      const activeElement = document.getElementById(activeId);
      if (activeElement === null) throw new Error("active row not found");
      expect(activeElement.textContent).toContain("Opus");

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());

      const assertSurvived = (): void => {
        expect(dropdownName()).toBe("Claude profile: Work");
        expect(activeOptionId(search)).toBe(activeId);
        const stillActive = document.getElementById(activeId);
        expect(stillActive?.textContent).toContain("Opus");
      };
      assertSurvived();
      await act(async () => {});
      assertSurvived();
    });

    it("(C1, pin) a recommendation that moves to another provider re-anchors the active row on its own selection", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });
      const search = searchBox(dialog);

      // Walk the active row onto a specific Claude row - it cannot possibly
      // survive a move to Codex, so the fallback anchor is exercised
      // deliberately rather than by accident.
      fireEvent.keyDown(search, { key: "ArrowDown" });
      const beforeId = activeOptionId(search);
      const beforeElement = document.getElementById(beforeId);
      if (beforeElement === null) throw new Error("active row not found");
      expect(beforeElement.textContent).not.toContain("GPT");

      kit.listData = listingOf({
        failedTuple: TARGET,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-c1", target: TARGET })],
      });
      view.rerenderWith(countdown());
      await act(async () => {});

      const recommendedRow = screen.getByRole("option", { name: /GPT-5/ });
      expect(activeOptionId(search)).toBe(recommendedRow.id);
    });

    it("(C2) a recommendation that moves to another provider keeps the query and re-anchors on the first visible match", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });
      const search = searchBox(dialog);

      fireEvent.change(search, { target: { value: "4" } });
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);

      kit.listData = listingOf({
        failedTuple: TARGET,
        profileTargets: [],
        modelTargets: [modelTargetOf({ groupId: "grp-c2", target: TARGET })],
      });
      view.rerenderWith(countdown());
      await act(async () => {});

      expect(search.value).toBe("4");
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(1);
      const onlyOption = options.at(0);
      if (onlyOption === undefined) {
        throw new Error("expected exactly one visible option");
      }
      expect(onlyOption.textContent).toContain("GPT-4.1");
      expect(activeOptionId(search)).toBe(onlyOption.id);
    });

    it("(D) nothing remounts with a query typed: the same list node, query, and active row survive a same-provider seed", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });
      const search = searchBox(dialog);

      fireEvent.change(search, { target: { value: "opus" } });
      const filteredNames = screen
        .getAllByRole("option")
        .map((row) => row.textContent);
      expect(filteredNames.length).toBeGreaterThan(0);

      const listboxBefore = within(dialog).getByRole("listbox");
      const activeId = activeOptionId(search);

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());
      await act(async () => {});

      expect(within(dialog).getByRole("listbox")).toBe(listboxBefore);
      expect(search.value).toBe("opus");
      expect(activeOptionId(search)).toBe(activeId);
      expect(
        screen.getAllByRole("option").map((row) => row.textContent),
      ).toEqual(filteredNames);
    });

    it("(D2) nothing remounts with no query: the same list node survives a same-provider seed", async () => {
      kit.listData = undefined;
      const view = mountChip(countdown());
      await openChip();
      const dialog = screen.getByRole("dialog", { name: "Select model" });

      const listboxBefore = within(dialog).getByRole("listbox");

      kit.listData = listing({ recommendedWork: true });
      view.rerenderWith(countdown());
      await act(async () => {});

      expect(within(dialog).getByRole("listbox")).toBe(listboxBefore);
    });

    it("(E, pin) followSelectionRef moves only the rail: no seed-caused open, and a later real open shows the moved selection", async () => {
      const followSelectionRef = createRef<(() => void) | null>();
      const openRef = createRef<(() => void) | null>();
      const store = createComposerToolbarStore({
        purpose: "setting",
        seedKey: "direct-picker-seed",
        values: {
          permission: DEFAULT_PERMISSION,
          selection: {
            harnessId: "claude",
            modelSlug: "claude-sonnet-4",
            profileId: FAILED_PROFILE,
          },
          reasoning: "",
          serviceTier: "",
        },
        onSettingsChange: null,
        tuiOnly: false,
        chatLineCarriesAutoMode: null,
        hostId: null,
        reasoningFallback: "model-default",
      });

      const embedding: HarnessModelPickerEmbedding = {
        trigger: <button type="button">Open test picker</button>,
        providerSwitchModel: () => "",
        selectionMarked: true,
        openRef,
        closeRef: null,
        followSelectionRef,
        onOpenChange: null,
        footer: null,
      };

      render(
        <TooltipProvider>
          <TabHostProvider hostId={TAB_HOST_ID}>
            <HarnessModelPicker
              store={store}
              withServiceTier={false}
              withReasoning
              tuiOnly={false}
              lockedHarnessId={null}
              disabled={false}
              registerActivation={false}
              createProfileHostId={TAB_HOST_ID}
              runTargetHostId={TAB_HOST_ID}
              terminalLoginSurface={null}
              labelDisplay="model-only"
              profileAdmission={null}
              embedding={embedding}
            />
          </TabHostProvider>
        </TooltipProvider>,
      );

      // The store moves to another account on the SAME provider while the
      // popover is closed, then the embedding's own rail-follow handle runs -
      // exactly what the routing chooser's layout effect does for a late
      // seed. `followSelectionRef` is documented to move only the browsed
      // rail, never the popover's visible open state.
      expect(followSelectionRef.current).not.toBeNull();
      const follow = followSelectionRef.current;
      if (follow === null) throw new Error("followSelectionRef was not filled");
      act(() => {
        store.getState().setSelection({
          harnessId: "claude",
          modelSlug: "claude-sonnet-4",
          profileId: WORK_PROFILE,
        });
        follow();
      });

      expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open test picker" }));
      await screen.findByRole("dialog", { name: "Select model" });

      expect(dropdownName()).toBe("Claude profile: Work");
    });
  });
});
