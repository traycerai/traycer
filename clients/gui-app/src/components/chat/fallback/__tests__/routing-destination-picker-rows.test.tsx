import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatFallbackListTargetsResponse,
  FallbackModelTarget,
  FallbackProfileTarget,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import { chatFallbackListTargetsResponseSchema } from "@traycer/protocol/host/chat-fallback";
import type { RoutingDestinationEntry } from "@/components/chat/fallback/routing-destination-picker";
import {
  HOST_UNREACHABLE_LABEL,
  describeListTargetsOutcome,
} from "@/components/chat/fallback/fallback-copy";
import { formatClockTime, formatResetDateTime } from "@/lib/relative-time";
import {
  countdownAt,
  failedTurn,
  footerConfirm,
  mount,
  open,
  option,
  seedProviders,
  FAILED,
  RESETS_AT,
  TARGET,
  WORK_PROFILE,
  ATTEMPT_MESSAGE_ID,
  ATTEMPT_TURN_ID,
  waiting,
} from "./routing-picker-scene";
import {
  countdownPending,
  heldLease,
  kit,
  resetKit,
} from "./routing-picker-kit";
import {
  BANNED_VOCABULARY,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  fallbackModelTarget,
  fallbackProfileTarget,
  fallbackSkip,
  lastFailedAttempt,
  listTargetsResponse,
} from "./fallback-fixtures";

/**
 * The chooser's Suggested rows and the listing's states.
 *
 * Ports what `fallback-destination-menu.test.tsx` pinned about rows, usage,
 * empty and moved-on states and the live announcements - now against the
 * chooser that replaced that menu. The rules that moved are stated where they
 * moved: a row is an option in the composer's picker, its usage is the LIVE
 * account reading (the listing's own severity and percentage are no longer
 * drawn), and Retry / Wait / "Try again" are rows of the same section.
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

const GROUP_ID = "grp-internal-secret-xyz";

function profileRow(input: {
  readonly profileId: string | null;
  readonly label: string;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
  readonly recommended: boolean;
}): FallbackProfileTarget {
  return fallbackProfileTarget({
    profileId: input.profileId,
    label: input.label,
    severity: "ok",
    usedPercent: 10,
    recommended: input.recommended,
    selectable: input.selectable,
    skip: input.skip,
  });
}

function modelRow(input: {
  readonly harnessId: string;
  readonly modelFamily: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly target: ChatRunSettings | null;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
  readonly warnings: ReadonlyArray<string>;
}): FallbackModelTarget {
  return fallbackModelTarget({
    groupId: GROUP_ID,
    harnessId: input.harnessId,
    modelFamily: input.modelFamily,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    profileId: input.target === null ? null : input.target.profileId,
    severity: "ok",
    usedPercent: 10,
    target: input.target,
    warnings: input.warnings,
    selectable: input.selectable,
    skip: input.skip,
  });
}

function listed(input: {
  readonly profileTargets: FallbackProfileTarget[];
  readonly modelTargets: FallbackModelTarget[];
}): ChatFallbackListTargetsResponse {
  return listTargetsResponse({
    outcome: "listed",
    failedTuple: FAILED,
    profileTargets: input.profileTargets,
    modelTargets: input.modelTargets,
    modelTargetsSkip: null,
  });
}

/** The Suggested options only: what the injected section put in the list. */
function suggestionOptions(): HTMLElement[] {
  return screen
    .getAllByRole("option")
    .filter((element) => element.hasAttribute("data-suggestion-action"));
}

function suggestionText(): string {
  return suggestionOptions()
    .map((element) => element.textContent)
    .join(" | ");
}

/** The `sr-only` announcement region: the SECOND `role="status"` in the popover. */
function announcementRegion(): HTMLElement {
  const regions = screen.getAllByRole("status");
  expect(regions).toHaveLength(2);
  return regions[1];
}

describe("RoutingDestinationPicker rows and listing", () => {
  beforeEach(() => {
    resetKit();
    seedProviders();
  });

  afterEach(() => {
    cleanup();
  });

  describe("what a row says", () => {
    it("names profile and model rows by display name, never a harness id, an engine word or the group id", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "sonnet",
            model: TARGET_CODEX_TUPLE.model,
            reasoningEffort: null,
            target: TARGET,
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      const text = suggestionText();
      expect(text).toContain("work-account");
      // The resolved MODEL wins over the family, and the provider is named by
      // its display name on the row's second line.
      expect(text).toContain("gpt-5");
      expect(text).toContain("Codex · Codex Team");
      expect(text).not.toMatch(/\bcodex ·/);
      // The row's own title is the resolved model, not the family (the
      // profile row's subtitle legitimately names the failed model).
      expect(suggestionOptions()[1].textContent).not.toContain("sonnet");
      expect(text).not.toMatch(BANNED_VOCABULARY);
      expect(text).not.toContain(GROUP_ID);
    });

    it("titles a resolved model row by its resolved slug and effort, not the equivalence-group family", async () => {
      const resolved = chatRunSettings({
        harnessId: "codex",
        model: "gpt-6-astra",
        profileId: null,
      });
      kit.listData = listed({
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: "gpt-6-astra",
            reasoningEffort: "high",
            target: resolved,
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      const row = suggestionOptions()[0];
      expect(row.textContent).toContain("gpt-6-astra · high");
      expect(row.textContent).not.toMatch(/gpt(?!-)/);
    });

    it("titles a resolved model row by the catalogue label for its slug, not the raw slug", async () => {
      kit.modelLabels = new Map([["codex:gpt-6-astra", "GPT-6 Astra"]]);
      kit.listData = listed({
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: "gpt-6-astra",
            reasoningEffort: "high",
            target: chatRunSettings({
              harnessId: "codex",
              model: "gpt-6-astra",
              profileId: null,
            }),
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      const row = suggestionOptions()[0];
      expect(row.textContent).toContain("GPT-6 Astra · high");
      expect(row.textContent).not.toContain("gpt-6-astra");
    });

    it("falls back to the equivalence-group family when the host resolved no model, and never relabels it through the catalogue", async () => {
      // A family that IS a catalogue key: a resolver applied to the family arm
      // would name a model the host explicitly could not resolve.
      kit.modelLabels = new Map([["codex:gpt", "GPT-5"]]);
      kit.listData = listed({
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: null,
            reasoningEffort: null,
            target: null,
            selectable: false,
            skip: fallbackSkip({
              reason: "unresolved",
              label: "No matching model on this provider",
            }),
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      const row = suggestionOptions()[0];
      expect(row.textContent).toContain("gpt");
      expect(row.textContent).not.toContain("GPT-5");
      expect(row.textContent).toContain("No matching model on this provider");
      expect(row.getAttribute("aria-disabled")).toBe("true");
    });

    it("shows the host's warnings beside a row's skip label, and drops a model row for a harness this build does not know", async () => {
      kit.listData = listed({
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt-5",
            model: "gpt-5",
            reasoningEffort: null,
            target: TARGET,
            selectable: true,
            skip: null,
            warnings: ["Uses a different context window"],
          }),
          modelRow({
            harnessId: "some-new-harness",
            modelFamily: "novel",
            model: "novel-1",
            reasoningEffort: null,
            target: chatRunSettings({
              harnessId: "codex",
              model: "novel-1",
              profileId: null,
            }),
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      expect(suggestionOptions()).toHaveLength(1);
      expect(suggestionText()).toContain("Uses a different context window");
      expect(suggestionText()).not.toContain("novel");
    });

    it("marks the host's recommended account with a Recommended badge", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: true,
          }),
        ],
        modelTargets: [],
      });
      mount(failedTurn(["switch"]));
      await open();

      expect(
        within(suggestionOptions()[0]).getByText("Recommended"),
      ).toBeDefined();
    });

    it("orders the rows: sibling accounts, equivalent models, then Wait, then Try again", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt-5",
            model: "gpt-5",
            reasoningEffort: null,
            target: TARGET,
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["retry", "switch", "wait_once"]));
      await open();

      expect(
        suggestionOptions().map((row) =>
          row.getAttribute("data-suggestion-action"),
        ),
      ).toEqual(["switch", "switch", "wait", "retry"]);
      const options = suggestionOptions();
      expect(options[0].textContent).toContain("work-account");
      expect(options[2].textContent).toContain("Wait until");
      expect(options[3].textContent).toContain("Try Personal again");
    });
  });

  describe("which rows can be picked", () => {
    async function openWithSkips() {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "plain",
            label: "plain-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
          profileRow({
            profileId: "blocked",
            label: "blocked-account",
            selectable: false,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried",
            }),
            recommended: false,
          }),
          profileRow({
            profileId: "tried",
            label: "already-tried-account",
            selectable: true,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried this turn",
            }),
            recommended: false,
          }),
          profileRow({
            profileId: "limited",
            label: "rate-limited-account",
            selectable: true,
            skip: fallbackSkip({
              reason: "rate-limited",
              label: "Limit reached right now",
            }),
            recommended: false,
          }),
          profileRow({
            profileId: "mystery",
            label: "unknown-skip-account",
            selectable: true,
            skip: fallbackSkip({
              reason: "a-reason-this-build-has-never-heard-of",
              label: "Host skip label verbatim",
            }),
            recommended: false,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt-5",
            model: TARGET_CODEX_TUPLE.model,
            reasoningEffort: null,
            target: TARGET,
            selectable: true,
            skip: fallbackSkip({
              reason: "rate-limited",
              label: "Model limit reached right now",
            }),
            warnings: [],
          }),
        ],
      });
      const view = mount(failedTurn(["switch"]));
      await open();
      return view;
    }

    it("dims a host-unselectable row and a rate-limited one, keeps an already-tried one pickable, and treats an unknown skip reason as pickable", async () => {
      await openWithSkips();

      expect(option(/^plain-account/).getAttribute("aria-disabled")).toBe(
        "false",
      );
      expect(option(/blocked-account/).getAttribute("aria-disabled")).toBe(
        "true",
      );

      // `already-tried` is a fact about this traversal, not the destination.
      const tried = option(/already-tried-account/);
      expect(tried.getAttribute("aria-disabled")).toBe("false");
      expect(tried.textContent).toContain("Already tried this turn");

      // `rate-limited` is CURRENT evidence the destination is dead - on an
      // account row and on a model row alike.
      expect(option(/rate-limited-account/).getAttribute("aria-disabled")).toBe(
        "true",
      );
      const limitedModel = option(/Codex · Codex Team/);
      expect(limitedModel.getAttribute("aria-disabled")).toBe("true");
      expect(limitedModel.textContent).toContain(
        "Model limit reached right now",
      );

      // An unrecognised reason degrades to pickable, and prints the host's
      // own words.
      const unknown = option(/unknown-skip-account/);
      expect(unknown.getAttribute("aria-disabled")).toBe("false");
      expect(unknown.textContent).toContain("Host skip label verbatim");
    });

    it("picks nothing from a dimmed row: no selection moves, no confirm, no send", async () => {
      await openWithSkips();
      const before = kit.mutations.length;

      fireEvent.click(option(/rate-limited-account/));
      fireEvent.click(option(/blocked-account/));
      fireEvent.click(option(/Codex · Codex Team/));

      expect(footerConfirm().disabled).toBe(true);
      expect(kit.mutations).toHaveLength(before);
    });

    it("never sends from a model row whose target is null, whatever the host's selectable says", async () => {
      kit.listData = listed({
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "claude",
            modelFamily: "sonnet",
            model: null,
            reasoningEffort: null,
            target: null,
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      const row = suggestionOptions()[0];
      expect(row.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(row);
      expect(footerConfirm().disabled).toBe(true);
      expect(kit.mutations).toEqual([]);
    });

    it("builds a sibling-account row from the entry's own tuple when the listing came back with no failed tuple", async () => {
      // The listing's `failedTuple` is `null`; the chooser was opened FROM a
      // failed tuple, and that is what an account switch swaps the account of.
      kit.listData = listTargetsResponse({
        outcome: "listed",
        failedTuple: null,
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "orphan-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      });
      mount(failedTurn(["switch"]));
      await open();

      expect(option(/orphan-account/).getAttribute("aria-disabled")).toBe(
        "false",
      );
      fireEvent.click(option(/orphan-account/));
      fireEvent.click(footerConfirm());
      expect(kit.mutations[0].variables.target).toEqual({
        ...FAILED,
        profileId: WORK_PROFILE,
      });
    });
  });

  describe("usage", () => {
    async function openOneAccount() {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      const view = mount(failedTurn(["switch"]));
      await open();
      return view;
    }

    it("says Checking usage… while the account's check is in flight", async () => {
      kit.ensureFreshHangs = true;
      await openOneAccount();

      expect(option(/work-account/).textContent).toContain("Checking usage…");
      expect(
        screen.queryByRole("button", { name: "Check usage again" }),
      ).toBeNull();
    });

    it("says Checking usage… while a refresh is running, even once the first check settled", async () => {
      kit.usage.set(`claude-code|${WORK_PROFILE}`, {
        detail: { kind: "never-checked" },
        fetchEligible: true,
        refreshStatus: "refreshing",
      });
      await openOneAccount();

      await waitFor(() => {
        expect(option(/work-account/).textContent).toContain("Checking usage…");
      });
    });

    it("says Not checked, with a button to ask again, when the check came back with nothing to show", async () => {
      await openOneAccount();

      await waitFor(() => {
        expect(option(/work-account/).textContent).toContain("Not checked");
      });
      const again = screen.getByRole("button", { name: "Check usage again" });
      // Outside the option: a button nested in an option is unreachable.
      expect(option(/work-account/).contains(again)).toBe(false);
      fireEvent.click(again);
      expect(kit.refreshCalls).toEqual([
        { providerId: "claude-code", profileId: WORK_PROFILE },
      ]);
    });

    it("prints the reading when there is one, and no Not checked beside it", async () => {
      kit.usage.set(`claude-code|${WORK_PROFILE}`, {
        detail: { kind: "semantic-only", status: "near_limit" },
        fetchEligible: true,
        refreshStatus: "idle",
      });
      await openOneAccount();

      await waitFor(() => {
        expect(option(/work-account/).textContent).toContain("Running low");
      });
      expect(option(/work-account/).textContent).not.toContain("Not checked");
      expect(
        screen.queryByRole("button", { name: "Check usage again" }),
      ).toBeNull();
    });

    it("draws no usage cell for an account this client cannot check and has no reading for, and keeps a reading it does have", async () => {
      kit.usage.set(`claude-code|${WORK_PROFILE}`, {
        detail: { kind: "never-checked" },
        fetchEligible: false,
        refreshStatus: "idle",
      });
      await openOneAccount();
      expect(option(/work-account/).textContent).not.toMatch(
        /Checking usage|Not checked|Running low|Healthy|Limited/,
      );
      cleanup();

      resetKit();
      seedProviders();
      kit.usage.set(`claude-code|${WORK_PROFILE}`, {
        detail: { kind: "semantic-only", status: "hard_limit" },
        fetchEligible: false,
        refreshStatus: "idle",
      });
      await openOneAccount();
      expect(option(/work-account/).textContent).toContain("Limited");
    });

    it("gives every row its own usage statement: reading, checking and not-checked are distinct on one screen", async () => {
      kit.usage.set(`claude-code|${WORK_PROFILE}`, {
        detail: { kind: "semantic-only", status: "near_limit" },
        fetchEligible: true,
        refreshStatus: "idle",
      });
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt-5",
            model: "gpt-5",
            reasoningEffort: null,
            target: TARGET,
            selectable: true,
            skip: null,
            warnings: [],
          }),
        ],
      });
      mount(failedTurn(["switch"]));
      await open();

      await waitFor(() => {
        expect(option(/work-account/).textContent).toContain("Running low");
        expect(option(/Codex · Codex Team/).textContent).toContain(
          "Not checked",
        );
      });
    });
  });

  describe("empty and moved-on states", () => {
    it("says a model is not set up, names the chat by its catalogue label, and still offers every model below", async () => {
      kit.modelLabels = new Map([
        ["claude:claude-sonnet-4", "Claude Sonnet Test"],
      ]);
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      mount(failedTurn(["switch"]));
      await open();

      expect(
        screen.getByText(
          "No other model is set up for Claude Code · Claude Sonnet Test. Pick any model below, or set up routing in Settings",
        ),
      ).toBeDefined();
      expect(screen.queryByText(/claude-sonnet-4\./)).toBeNull();
      expect(option(/Claude Opus 4/)).toBeDefined();
      expect(suggestionOptions()).toEqual([]);
    });

    it("does not say the model is not set up while Retry or Wait are on offer - a row is a row", async () => {
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      mount(failedTurn(["retry", "switch"]));
      await open();

      expect(screen.queryByText(/No other model is set up/)).toBeNull();
      expect(suggestionOptions()).toHaveLength(1);
    });

    it("hides the Retry and Wait rows for an auth failure, and each without its own eligibility", async () => {
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      const authAttempt: LastFailedAttempt = lastFailedAttempt({
        userMessageId: ATTEMPT_MESSAGE_ID,
        turnId: ATTEMPT_TURN_ID,
        failure: {
          reason: "auth",
          resetsAt: RESETS_AT,
          resetsAtSource: "provider",
        },
        eligibleRungs: ["retry", "switch", "wait_once"],
        waitDisposition: "eligible",
        switchDisposition: "eligible",
        failedTuple: FAILED,
      });
      const view = mount({
        kind: "failed-turn",
        attempt: authAttempt,
        seedTuple: FAILED,
      });
      await open();
      expect(suggestionOptions()).toEqual([]);
      view.unmount();
      cleanup();

      // Retry eligible, Wait not.
      mount(failedTurn(["retry", "switch"]));
      await open();
      expect(
        suggestionOptions().map((row) =>
          row.getAttribute("data-suggestion-action"),
        ),
      ).toEqual(["retry"]);
      cleanup();

      // Wait eligible, but no reset time to wait for.
      const noReset = lastFailedAttempt({
        userMessageId: ATTEMPT_MESSAGE_ID,
        turnId: ATTEMPT_TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ["wait_once"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "eligible",
        failedTuple: FAILED,
      });
      mount({ kind: "failed-turn", attempt: noReset, seedTuple: FAILED });
      await open();
      expect(suggestionOptions()).toEqual([]);
    });

    it("renders a sentence and no rows for every non-listed outcome, once visibly and once in the live region", async () => {
      for (const outcome of chatFallbackListTargetsResponseSchema.shape.outcome
        .options) {
        if (outcome === "listed") continue;
        const sentence = describeListTargetsOutcome(outcome);
        if (sentence === null) throw new Error(`expected copy for ${outcome}`);
        kit.listData = listTargetsResponse({
          outcome,
          failedTuple: FAILED,
          profileTargets: [
            profileRow({
              profileId: WORK_PROFILE,
              label: "should-not-render",
              selectable: true,
              skip: null,
              recommended: false,
            }),
          ],
          modelTargets: [],
          modelTargetsSkip: null,
        });
        mount(failedTurn(["switch"]));
        await open();

        // Two copies, and the count is the assertion: one is the visible body
        // line, one is the `sr-only` live region - a body that swaps under an
        // open popover is a change no screen reader is looking at.
        const matches = screen.getAllByText(sentence);
        expect(matches).toHaveLength(2);
        expect(
          matches.filter((element) => announcementRegion().contains(element)),
        ).toHaveLength(1);
        expect(screen.queryByText("should-not-render")).toBeNull();
        expect(suggestionOptions()).toEqual([]);
        cleanup();
      }
    });

    it("says the host is unreachable when the listing itself fails, in the body and in the live region, and offers the models below", async () => {
      kit.listData = undefined;
      kit.listError = true;
      mount(failedTurn(["switch"]));
      await open();

      const matches = screen.getAllByText(HOST_UNREACHABLE_LABEL);
      expect(matches).toHaveLength(2);
      expect(
        matches.filter((element) => announcementRegion().contains(element)),
      ).toHaveLength(1);
      expect(option(/Claude Opus 4/)).toBeDefined();
    });
  });

  describe("the live regions", () => {
    it("announces how many suggestions can be picked, counting only the selectable ones", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "a",
            label: "a-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
          profileRow({
            profileId: "b",
            label: "b-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
          profileRow({
            profileId: "c",
            label: "c-account",
            selectable: false,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried",
            }),
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      mount(failedTurn(["switch"]));
      await open();

      expect(announcementRegion().textContent).toBe(
        "2 suggested destinations available.",
      );
    });

    it("announces the singular, and announces that nothing can be picked when every row is dimmed - the rows stay on screen", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "a",
            label: "a-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(announcementRegion().textContent).toBe(
        "1 suggested destination available.",
      );
      view.unmount();
      cleanup();

      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "c",
            label: "c-account",
            selectable: false,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried",
            }),
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      mount(failedTurn(["switch"]));
      await open();
      expect(announcementRegion().textContent).toBe(
        "No suggested destinations are available.",
      );
      // Dimmed rows are still rows: the body does not say nothing is set up.
      expect(option(/c-account/)).toBeDefined();
      expect(screen.queryByText(/No other model is set up/)).toBeNull();
    });

    it("stays silent while loading, then announces the count once the listing arrives", async () => {
      kit.listData = undefined;
      const view = mount(failedTurn(["switch"]));
      await open();
      expect(announcementRegion().textContent).toBe("");

      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "a",
            label: "a-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      view.rerenderWith(failedTurn(["switch"]));

      expect(announcementRegion().textContent).toBe(
        "1 suggested destination available.",
      );
    });

    it("keeps the previous rows on screen while a refetch is in flight, says nothing about them, and speaks once it settles", async () => {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: "a",
            label: "a-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      kit.listFetching = true;
      const view = mount(failedTurn(["switch"]));
      await open();

      expect(option(/a-account/)).toBeDefined();
      expect(announcementRegion().textContent).toBe("");

      kit.listFetching = false;
      view.rerenderWith(failedTurn(["switch"]));
      expect(announcementRegion().textContent).toBe(
        "1 suggested destination available.",
      );
    });

    it("keeps a live region for the refusal line even with nothing to say - persistent, and sr-only when empty rather than removed", async () => {
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      mount(failedTurn(["switch"]));
      await open();

      const refusal = screen.getAllByRole("status")[0];
      expect(refusal.textContent).toBe("");
      expect(refusal.className).toContain("empty:sr-only");
      expect(refusal.className).not.toContain("empty:hidden");
      expect(refusal.getAttribute("aria-live")).toBe("polite");
    });

    it("moves the refusal region from silent to the refused-hold sentence without moving focus", async () => {
      kit.lease = null;
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      const view = mount(
        countdownAt(
          countdownPending({
            state: "hold",
            revision: 1,
            queuedItemsMoving: 0,
          }),
        ),
      );
      await open();
      const input = screen.getByRole("textbox", { name: /^Search/ });
      input.focus();
      expect(screen.getAllByRole("status")[0].textContent).toBe("");

      kit.lease = heldLease("refused", null);
      view.rerenderWith(
        countdownAt(
          countdownPending({
            state: "hold",
            revision: 2,
            queuedItemsMoving: 0,
          }),
        ),
      );

      expect(screen.getAllByRole("status")[0].textContent).toBe(
        "Couldn't pause the countdown.",
      );
      expect(document.activeElement).toBe(input);
    });
  });

  describe("the footer's words", () => {
    async function pickWork(entry: RoutingDestinationEntry) {
      kit.listData = listed({
        profileTargets: [
          profileRow({
            profileId: WORK_PROFILE,
            label: "work-account",
            selectable: true,
            skip: null,
            recommended: false,
          }),
        ],
        modelTargets: [],
      });
      mount(entry);
      await open();
      fireEvent.click(option(/work-account/));
    }

    it("the error row says the queue moves without naming a number it does not have", async () => {
      await pickWork(failedTurn(["switch"]));

      expect(
        screen.getByText(
          "Replays this message on the destination you pick. Starts a fresh session from this transcript. Any queued messages move with it.",
        ),
      ).toBeDefined();
    });

    it("the countdown and the waiting card name how many queued messages move with a switch - and nothing at zero", async () => {
      kit.lease = heldLease("held", "tok-1");
      await pickWork(
        countdownAt(
          countdownPending({
            state: "choosing",
            revision: 2,
            queuedItemsMoving: 3,
          }),
        ),
      );
      expect(
        screen.getByText(
          /3 queued messages will run on the new settings too\./,
        ),
      ).toBeDefined();
      cleanup();

      await pickWork(
        countdownAt(
          countdownPending({
            state: "choosing",
            revision: 2,
            queuedItemsMoving: 1,
          }),
        ),
      );
      expect(
        screen.getByText(/1 queued message will run on the new settings too\./),
      ).toBeDefined();
      cleanup();

      await pickWork(
        countdownAt(
          countdownPending({
            state: "choosing",
            revision: 2,
            queuedItemsMoving: 0,
          }),
        ),
      );
      expect(
        screen.getByText(
          "Replays this message on the destination you pick. Starts a fresh session from this transcript.",
        ),
      ).toBeDefined();
    });

    it("the waiting card says when the wait ends if nothing is picked, and says nothing when the host gave no deadline", async () => {
      const deadline = new Date(2026, 5, 15, 15, 0, 0).getTime();
      const pending = countdownPending({
        state: "waiting",
        revision: 3,
        queuedItemsMoving: 0,
      });
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      const view = mount({
        kind: "waiting",
        pending: { ...pending, deadline },
      });
      await open();
      expect(
        screen.getByText(
          `Resumes at ${formatClockTime(deadline)} unless you pick something.`,
        ),
      ).toBeDefined();
      view.unmount();
      cleanup();

      mount({ kind: "waiting", pending: { ...pending, deadline: null } });
      await open();
      expect(screen.queryByText(/Resumes at/)).toBeNull();
    });

    it("names the resume time with its weekday once it is a day or more away", async () => {
      const far = Date.now() + 4 * 24 * 60 * 60_000;
      const pending = countdownPending({
        state: "waiting",
        revision: 3,
        queuedItemsMoving: 0,
      });
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      mount({ kind: "waiting", pending: { ...pending, deadline: far } });
      await open();

      expect(
        screen.getByText(
          `Resumes at ${formatResetDateTime(far)} unless you pick something.`,
        ),
      ).toBeDefined();
    });

    it("the error row and the countdown draw no waiting-card line", async () => {
      kit.listData = listed({ profileTargets: [], modelTargets: [] });
      mount(failedTurn(["switch"]));
      await open();

      expect(screen.queryByText(/Resumes at/)).toBeNull();
      expect(screen.queryByText(/Countdown paused/)).toBeNull();
    });
  });

  it("answers a pick made after the chooser has closed on the chat's announcer, not inline - the surface it was picked from is gone (MF11)", async () => {
    kit.listData = listed({ profileTargets: [], modelTargets: [] });
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

  it("answers a bare Retry sent after the chooser has closed with a toast, once, and nothing to the announcer (MF11)", async () => {
    kit.listData = listed({ profileTargets: [], modelTargets: [] });
    kit.deferResponses = true;
    kit.mutationResult = { outcome: "rung_unavailable", detail: null };
    const view = mount(failedTurn(["retry", "switch"]));
    await open();
    fireEvent.click(option(/Try Personal again/));
    fireEvent.click(footerConfirm());
    view.unmount();
    act(() => {
      kit.pendingResponses[0]();
    });

    expect(kit.toast).toHaveBeenCalledTimes(1);
    expect(kit.toast).toHaveBeenCalledWith(
      "That action isn't available right now.",
    );
    expect(kit.unattended).toEqual([]);
  });

  it("a confirmed switch is recorded for the announcer whether or not the chooser is still there", async () => {
    kit.listData = listed({ profileTargets: [], modelTargets: [] });
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
        target: {
          ...FAILED,
          model: "claude-opus-4",
        },
      },
    ]);
    // An applied switch closes the chooser and prints nothing.
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    });
  });
});
