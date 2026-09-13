import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatFallbackListTargetsResponse,
  FallbackModelTarget,
  FallbackProfileTarget,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import { chatFallbackListTargetsResponseSchema } from "@traycer/protocol/host/chat-fallback";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FallbackDestinationMenu } from "@/components/chat/fallback/fallback-destination-menu";
import {
  FallbackGraceMenu,
  FallbackWaitingMenu,
} from "@/components/chat/fallback/fallback-card-menus";
import {
  COUNTDOWN_NOT_PAUSED_LABEL,
  FINDING_DESTINATIONS_LABEL,
  HOST_UNREACHABLE_LABEL,
  NO_DESTINATIONS_LABEL,
  NO_SELECTABLE_DESTINATIONS_LABEL,
  PAUSING_COUNTDOWN_LABEL,
  describeListTargetsOutcome,
} from "@/components/chat/fallback/fallback-copy";
import { formatClockTime, formatResetDateTime } from "@/lib/relative-time";
import type { FallbackChoiceLease } from "@/stores/chats/chat-session-store";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  fallbackModelTarget,
  fallbackProfileTarget,
  fallbackSkip,
  listTargetsResponse,
  pendingFallback,
} from "./fallback-fixtures";

const EPIC_ID = "epic-dest";
const CHAT_ID = "chat-dest";
const HOST_ID = "host-dest";
const GROUP_ID = "grp-internal-secret-xyz";
const EMPTY_ACTIONS_MARKER = "empty-actions-marker";

const listHarness = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly enabled: boolean;
    readonly selector: unknown;
  }>,
  data: undefined as ChatFallbackListTargetsResponse | undefined,
  isPending: false,
  isFetching: false,
  isError: false,
}));

const leaseHarness = vi.hoisted(() => ({
  lease: null as FallbackChoiceLease | null,
  hold: vi.fn(),
  release: vi.fn(),
}));

const actionHarness = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  openSettings: vi.fn(),
}));

vi.mock("@/components/chat/fallback/use-fallback-targets", () => ({
  useFallbackListTargets: (
    _client: unknown,
    input: { readonly enabled: boolean; readonly selector: unknown },
  ) => {
    listHarness.calls.push({
      enabled: input.enabled,
      selector: input.selector,
    });
    return {
      data: listHarness.data,
      isPending: listHarness.isPending,
      isFetching: listHarness.isFetching,
      isError: listHarness.isError,
    };
  },
}));

vi.mock("@/components/chat/fallback/use-fallback-choice-lease", () => ({
  useFallbackChoiceLease: () => ({
    lease: leaseHarness.lease,
    hold: leaseHarness.hold,
    release: leaseHarness.release,
  }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: actionHarness.mutate,
    isPending: actionHarness.isPending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: actionHarness.openSettings,
  }),
}));

function meterIn(row: HTMLElement): HTMLElement | null {
  return row.querySelector("span.h-1.shrink-0.overflow-hidden.rounded-full");
}

function profileRow(input: {
  readonly profileId: string | null;
  readonly label: string;
  readonly severity: string;
  readonly usedPercent: number | null;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
}) {
  return fallbackProfileTarget({
    profileId: input.profileId,
    label: input.label,
    severity: input.severity,
    usedPercent: input.usedPercent,
    recommended: false,
    selectable: input.selectable,
    skip: input.skip,
  });
}

function modelRow(input: {
  readonly harnessId: string;
  readonly modelFamily: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly severity: string;
  readonly usedPercent: number | null;
  readonly target: ChatRunSettings | null;
  readonly selectable: boolean;
  readonly skip: FallbackTargetSkip | null;
}) {
  return fallbackModelTarget({
    groupId: GROUP_ID,
    harnessId: input.harnessId,
    modelFamily: input.modelFamily,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    profileId: input.target === null ? null : input.target.profileId,
    severity: input.severity,
    usedPercent: input.usedPercent,
    target: input.target,
    warnings: [],
    selectable: input.selectable,
    skip: input.skip,
  });
}

function listed(input: {
  readonly failedTuple: ChatRunSettings | null;
  readonly profileTargets: FallbackProfileTarget[];
  readonly modelTargets: FallbackModelTarget[];
  readonly modelTargetsSkip: FallbackTargetSkip | null;
}) {
  return listTargetsResponse({
    outcome: "listed",
    failedTuple: input.failedTuple,
    profileTargets: input.profileTargets,
    modelTargets: input.modelTargets,
    modelTargetsSkip: input.modelTargetsSkip,
  });
}

function holdPending(state: "hold" | "choosing" | "waiting") {
  return pendingFallback({
    state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: new Date(2026, 5, 15, 15, 0, 0).getTime(),
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-dest",
    revision: 8,
  });
}

// The mocked lease this suite hand-sets (`leaseHarness.lease = ...`) rather
// than obtaining from a real store - see the file's `vi.mock` of
// `use-fallback-choice-lease`. `releaseRequested`/`connectionEpoch` are
// FIXED here at their ordinary-case values: every case in this file is a
// lease in normal standing, never a close-before-ack (`releaseRequested:
// true`, driven by the unmount tests through the mocked `release()`, never
// by constructing a lease) or a cross-connection one (`connectionEpoch`
// differing from the frame's - nothing in this file exercises a detach).
function graceLease(input: {
  readonly token: string | null;
  readonly status: FallbackChoiceLease["status"];
}): FallbackChoiceLease {
  return {
    traversalId: "traversal-dest",
    clientActionId: "action-1",
    token: input.token,
    status: input.status,
    releaseRequested: false,
    connectionEpoch: 0,
  };
}

function renderMenu(input: {
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly open: boolean;
  readonly preparing: boolean;
  readonly picking: boolean;
  readonly refusal: string | null;
  readonly header: string | null;
  readonly emptyStateActions: ReactNode | null;
  readonly onPick: (target: ChatRunSettings) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  listHarness.data = input.data;
  return render(
    <TabHostProvider hostId={HOST_ID}>
      <FallbackDestinationMenu
        triggerLabel="Open destinations"
        triggerDisabled={false}
        header={input.header}
        selector={{
          kind: "traversal",
          traversalId: "traversal-dest",
          revision: 8,
        }}
        epicId={EPIC_ID}
        chatId={CHAT_ID}
        client={null}
        open={input.open}
        onOpenChange={input.onOpenChange}
        onPick={input.onPick}
        picking={input.picking}
        preparing={input.preparing}
        refusal={input.refusal}
        emptyStateActions={input.emptyStateActions}
      />
    </TabHostProvider>,
  );
}

describe("FallbackDestinationMenu", () => {
  beforeEach(() => {
    listHarness.calls = [];
    listHarness.data = undefined;
    listHarness.isPending = false;
    listHarness.isFetching = false;
    listHarness.isError = false;
    actionHarness.mutate.mockReset();
    actionHarness.openSettings.mockReset();
    leaseHarness.hold.mockReset();
    leaseHarness.release.mockReset();
    leaseHarness.lease = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders profile and model rows from the listed response, using display names not harness ids", () => {
    const onPick = vi.fn();
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "work-profile",
            label: "work-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [
          // A coherent fixture, deliberately: the resolved slug and the
          // equivalence-group family are DIFFERENT strings (MF03). The old
          // fixture here paired `modelFamily: "sonnet"` with a `target` whose
          // model was `gpt-5`, which was harmless only because the row used
          // to title itself from the family alone - the exact bug this
          // coherent shape exposes. See the two dedicated MF03 cases below
          // for the resolved and unresolved arms.
          modelRow({
            harnessId: "claude",
            modelFamily: "sonnet",
            model: TARGET_CODEX_TUPLE.model,
            reasoningEffort: null,
            severity: "ok",
            usedPercent: 10,
            target: TARGET_CODEX_TUPLE,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick,
      onOpenChange: () => undefined,
    });
    expect(
      screen.getByRole("heading", { name: "Other profiles" }),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Equivalent models" }),
    ).toBeDefined();
    expect(screen.getByText("work-account")).toBeDefined();
    // The resolved MODEL, not the family: `model` is `TARGET_CODEX_TUPLE.model`
    // ("gpt-5"), which now wins over `modelFamily` ("sonnet").
    expect(screen.getByText("Claude Code · gpt-5")).toBeDefined();
    // Falsification: render target.harnessId instead of fallbackHarnessLabelFor(...) and the "no raw harness id" assertion must go red.
    expect(screen.queryByText(/^claude · gpt-5$/)).toBeNull();
    const body = screen.getByRole("heading", {
      name: "Other profiles",
    }).parentElement;
    if (body === null || body.parentElement === null) {
      throw new Error("expected menu body");
    }
    expect(body.parentElement.textContent).not.toMatch(BANNED_VOCABULARY);
    // Falsification: render a group heading from groupId and this must go red.
    expect(body.parentElement.textContent).not.toContain(GROUP_ID);
  });

  // MF03: a model row used to title itself from the equivalence-group FAMILY
  // unconditionally, so a group named `gpt` resolving to `gpt-6-astra` offered
  // a click whose actual model the user never saw. The fixture below is the
  // positive pin - it deliberately makes the family and the resolved slug
  // DIFFERENT strings, because a fixture where they coincide (as the old
  // "claude"/"sonnet"-labeled-but-`TARGET_CODEX_TUPLE`-targeted row above did)
  // cannot tell a row that reads the resolved model from one that still reads
  // the family; that incoherent fixture is why this regression shipped once
  // already.
  it("titles a resolved model row by its resolved slug and effort, not the equivalence-group family", () => {
    // The click payload's OWN `reasoningEffort` is irrelevant here -
    // `fallbackDestinationOfModelTarget` reads the row's top-level
    // `reasoningEffort` (set on `modelRow` below), never this tuple's.
    const resolvedTarget = chatRunSettings({
      harnessId: "codex",
      model: "gpt-6-astra",
      profileId: null,
    });
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: null,
            label: "Terminal account",
            severity: "ok",
            usedPercent: null,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: "gpt-6-astra",
            reasoningEffort: "high",
            severity: "ok",
            usedPercent: null,
            target: resolvedTarget,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    // Falsification: restore `title={`${fallbackHarnessLabelFor(target.harnessId)} · ${target.modelFamily}`}` in FallbackDestinationMenu's model row and this must go red - the row would read "Codex · gpt" again.
    expect(screen.getByText("Codex · gpt-6-astra · high")).toBeDefined();
    // Negative half: the bare family must not appear as a row title on its own.
    expect(screen.queryByText(/^Codex · gpt$/)).toBeNull();
    expect(screen.queryByText(/^Codex · gpt ·/)).toBeNull();
  });

  // The fallback branch `fallbackDestinationOfModelTarget` takes when the host
  // could not resolve a slug for the group - unpinned by the case above, which
  // only exercises the resolved arm.
  it("falls back to the equivalence-group family when the host resolved no model", () => {
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: null,
            reasoningEffort: null,
            severity: "ok",
            usedPercent: null,
            target: null,
            selectable: false,
            skip: fallbackSkip({
              reason: "unresolved",
              label: "No matching model on this provider",
            }),
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    // Falsification: change `modelLabel: model ?? target.modelFamily` in
    // `fallbackDestinationOfModelTarget` to always use `model` and this must
    // go red (nothing to render at all, since `model` is `null`).
    expect(screen.getByText("Codex · gpt")).toBeDefined();
  });

  it("renders no meter when usedPercent is null", () => {
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "work-profile",
            label: "no-meter-account",
            severity: "ok",
            usedPercent: null,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    const row = screen.getByRole("button", { name: /no-meter-account/ });
    // Falsification: drop the usedPercent === null guard in UsageMeter and this must go red.
    expect(meterIn(row)).toBeNull();
  });

  it("renders no meter for an unknown severity, and does render one for near_limit", () => {
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "unknown-sev",
            label: "unknown-severity-account",
            severity: "something_this_build_has_never_heard_of",
            usedPercent: 80,
            selectable: true,
            skip: null,
          }),
          profileRow({
            profileId: "near-sev",
            label: "near-limit-account",
            severity: "near_limit",
            usedPercent: 80,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    const unknownRow = screen.getByRole("button", {
      name: /unknown-severity-account/,
    });
    expect(meterIn(unknownRow)).toBeNull();
    const nearRow = screen.getByRole("button", { name: /near-limit-account/ });
    expect(meterIn(nearRow)).not.toBeNull();
  });

  it("disables unselectable rows, keeps already-tried clickable, disables rate-limited, and treats unknown skip as clickable", () => {
    const onPick = vi.fn();
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "plain",
            label: "plain-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
          profileRow({
            profileId: "blocked",
            label: "blocked-account",
            severity: "ok",
            usedPercent: 10,
            selectable: false,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried",
            }),
          }),
          profileRow({
            profileId: "tried",
            label: "already-tried-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: fallbackSkip({
              reason: "already-tried",
              label: "Already tried this turn",
            }),
          }),
          profileRow({
            profileId: "limited",
            label: "rate-limited-account",
            severity: "hard_limit",
            usedPercent: 99,
            selectable: true,
            skip: fallbackSkip({
              reason: "rate-limited",
              label: "Limit reached right now",
            }),
          }),
          profileRow({
            profileId: "mystery",
            label: "unknown-skip-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: fallbackSkip({
              reason: "a-reason-this-build-has-never-heard-of",
              label: "Host skip label verbatim",
            }),
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt-5",
            model: TARGET_CODEX_TUPLE.model,
            reasoningEffort: null,
            severity: "hard_limit",
            usedPercent: 99,
            target: TARGET_CODEX_TUPLE,
            selectable: true,
            skip: fallbackSkip({
              reason: "rate-limited",
              label: "Model limit reached right now",
            }),
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick,
      onOpenChange: () => undefined,
    });

    const plain = screen.getByRole("button", { name: /plain-account/ });
    if (!(plain instanceof HTMLButtonElement)) {
      throw new Error("expected plain-account button");
    }
    expect(plain.disabled).toBe(false);

    const blocked = screen.getByRole("button", { name: /blocked-account/ });
    if (!(blocked instanceof HTMLButtonElement)) {
      throw new Error("expected blocked-account button");
    }
    expect(blocked.disabled).toBe(true);

    const tried = screen.getByRole("button", { name: /already-tried-account/ });
    if (!(tried instanceof HTMLButtonElement)) {
      throw new Error("expected already-tried-account button");
    }
    // Falsification: disable on skip !== null and this must go red.
    expect(tried.disabled).toBe(false);
    expect(tried.textContent).toContain("Already tried this turn");

    const limited = screen.getByRole("button", {
      name: /rate-limited-account/,
    });
    if (!(limited instanceof HTMLButtonElement)) {
      throw new Error("expected rate-limited-account button");
    }
    // Falsification: delete the skipIsCurrentDeadEvidence term from the row's disabled and this must go red.
    expect(limited.disabled).toBe(true);
    fireEvent.click(limited);
    expect(onPick).not.toHaveBeenCalled();

    const limitedModel = screen.getByRole("button", {
      name: /Codex · gpt-5/,
    });
    if (!(limitedModel instanceof HTMLButtonElement)) {
      throw new Error("expected rate-limited model button");
    }
    expect(limitedModel.disabled).toBe(true);
    fireEvent.click(limitedModel);
    expect(onPick).not.toHaveBeenCalled();

    const unknown = screen.getByRole("button", {
      name: /unknown-skip-account/,
    });
    if (!(unknown instanceof HTMLButtonElement)) {
      throw new Error("expected unknown-skip-account button");
    }
    // Falsification: make skipIsCurrentDeadEvidence return true for anything that fails to parse and this must go red.
    expect(unknown.disabled).toBe(false);
    expect(unknown.textContent).toContain("Host skip label verbatim");
  });

  // F23: `usageStatusText` is the row's actual accessible-name statement
  // (the bar beside it is `aria-hidden` decoration) and nothing pinned its
  // four distinct outputs. `usedPercent: null` is "not checked" and
  // `usedPercent: 0` is "known-zero" - the pair the review named specifically,
  // because collapsing them is the one direction this bug can hide in: a `||`
  // where the code means `??` reads 0 as falsy and reports it as unchecked.
  it("gives each row a distinct accessible name for healthy, limited, unread, and known-zero usage", () => {
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "healthy-profile",
            label: "healthy-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
          profileRow({
            profileId: "limited-profile",
            label: "limited-account",
            severity: "hard_limit",
            usedPercent: 95,
            selectable: true,
            skip: null,
          }),
          profileRow({
            profileId: "unread-profile",
            label: "unread-account",
            severity: "near_limit",
            usedPercent: null,
            selectable: true,
            skip: null,
          }),
          profileRow({
            profileId: "zero-profile",
            label: "zero-account",
            severity: "ok",
            usedPercent: 0,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });

    expect(
      screen.getByRole("button", {
        name: /healthy-account.*Healthy · 10% used/,
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: /limited-account.*Limited · 95% used/,
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: /unread-account.*Running low · usage not checked/,
      }),
    ).toBeDefined();
    // Falsification: change `usedPercent === null` to `!usedPercent` in
    // `usageStatusText` and THIS assertion goes red - the known-zero row would
    // then read "Usage not checked" too, identical to a gauge nobody read.
    expect(
      screen.getByRole("button", { name: /zero-account.*Healthy · 0% used/ }),
    ).toBeDefined();
  });

  // F23: the popover carries `aria-label` for its own name and, only when a
  // header is present, an `aria-describedby` naming that header's element -
  // nothing exercised the pairing (a screen reader announcing the dialog
  // reads the label as its NAME and the header as its DESCRIPTION, so the two
  // attributes must point at the same rendered text, not just both exist).
  it("names the dialog and, when a header is given, describes it by the header's own element", () => {
    const { unmount } = renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    const undescribed = screen.getByRole("dialog", {
      name: "Choose a destination",
    });
    expect(undescribed.getAttribute("aria-describedby")).toBeNull();
    unmount();

    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: "Switching now cancels the countdown",
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    const described = screen.getByRole("dialog", {
      name: "Choose a destination",
    });
    const describedBy = described.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    // Falsification: hardcode `aria-describedby` to a fixed string instead of
    // `headerId` and this goes red - it must name the header `<div>`'s ACTUAL
    // rendered id, not merely be non-null.
    const describingElement =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(describingElement?.textContent).toBe(
      "Switching now cancels the countdown",
    );
  });

  it("does not send from a model row whose target is null, whatever selectable says", () => {
    const onPick = vi.fn();
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [
          modelRow({
            harnessId: "claude",
            modelFamily: "sonnet",
            model: null,
            reasoningEffort: null,
            severity: "ok",
            usedPercent: 10,
            target: null,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick,
      onOpenChange: () => undefined,
    });
    const row = screen.getByRole("button", { name: /Claude Code · sonnet/ });
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error("expected model row");
    }
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("sends the failed tuple with profileId swapped, and disables profile rows when failedTuple is null", () => {
    const onPick = vi.fn<(target: ChatRunSettings) => void>();
    const { unmount } = renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "other-profile",
            label: "other-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick,
      onOpenChange: () => undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: /other-account/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
    const sent = onPick.mock.calls[0][0];
    expect(sent).toEqual({
      ...FAILED_CLAUDE_TUPLE,
      profileId: "other-profile",
    });
    unmount();

    const onPickEmpty = vi.fn();
    renderMenu({
      data: listed({
        failedTuple: null,
        profileTargets: [
          profileRow({
            profileId: "other-profile",
            label: "orphan-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: onPickEmpty,
      onOpenChange: () => undefined,
    });
    const orphan = screen.getByRole("button", { name: /orphan-account/ });
    if (!(orphan instanceof HTMLButtonElement)) {
      throw new Error("expected orphan-account button");
    }
    expect(orphan.disabled).toBe(true);
    fireEvent.click(orphan);
    expect(onPickEmpty).not.toHaveBeenCalled();
  });

  it("renders a sentence and no rows for every non-listed listTargets outcome", () => {
    for (const outcome of chatFallbackListTargetsResponseSchema.shape.outcome
      .options) {
      if (outcome === "listed") continue;
      const sentence = describeListTargetsOutcome(outcome);
      if (sentence === null) {
        throw new Error(`expected copy for ${outcome}`);
      }
      renderMenu({
        data: listTargetsResponse({
          outcome,
          failedTuple: FAILED_CLAUDE_TUPLE,
          profileTargets: [
            profileRow({
              profileId: "hidden",
              label: "should-not-render",
              severity: "ok",
              usedPercent: 10,
              selectable: true,
              skip: null,
            }),
          ],
          modelTargets: [],
          modelTargetsSkip: null,
        }),
        open: true,
        preparing: false,
        picking: false,
        refusal: null,
        header: null,
        emptyStateActions: null,
        onPick: () => undefined,
        onOpenChange: () => undefined,
      });
      // TWO copies, and the count is the assertion rather than an allowance.
      // One sits in the visible body, for a screen-reader user navigating the
      // popover and for everyone else reading it. One sits in the concise
      // `sr-only` live region, so the change is ANNOUNCED - nothing here moves
      // focus, and a body that swaps under an open popover is a change no
      // screen reader is looking at.
      //
      // The two alternatives were checked and are worse. Making a persistent
      // wrapper around the body live would announce the whole body on every
      // change, every destination row included, once the list arrives.
      // `aria-hidden` on the visible copy would delete the only readable
      // sentence in the body for the very users the live region is for.
      //
      // So `toHaveLength(2)` pins the duplication as INTENDED: it reds if the
      // live-region arm is removed (back to silence) and it reds if the
      // visible sentence goes (announced but unreadable).
      const matches = screen.getAllByText(sentence);
      expect(matches).toHaveLength(2);
      // A document-wide count alone cannot tell "one copy sits in the live
      // region" from "two visible copies happen to say the same words" - the
      // reviewer's own point about the earlier form of this assertion.
      // `role="status"` appears exactly twice per popover (refusal region,
      // then the sr-only announcement region below it - see the F25 (i)/(ii)
      // helpers above) - checked here rather than assumed, since a silent
      // regression that added a third would let positional reasoning about
      // "the" status region point at the wrong element.
      const statusRegionsHere = screen.getAllByRole("status");
      // This length assertion IS the guard - it fails the test when the second
      // region is missing, which is what an explicit `=== undefined` throw
      // below would have done. That throw was unreachable
      // (`noUncheckedIndexedAccess` is off, so the index read is typed
      // non-nullish) and the linter rejects it as a condition with no overlap.
      expect(statusRegionsHere).toHaveLength(2);
      const announcementRegionHere = statusRegionsHere[1];
      const matchesInsideAnnouncementRegion = matches.filter((el) =>
        announcementRegionHere.contains(el),
      );
      // Falsification: move the `describeListTargetsOutcome` call out of the
      // sr-only `menuStatusAnnouncement` div and into a second visible
      // element instead - the document-wide count stays 2, but this goes red
      // because neither copy is inside the live region any more.
      expect(matchesInsideAnnouncementRegion).toHaveLength(1);
      expect(screen.queryByText("should-not-render")).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Other profiles" }),
      ).toBeNull();
      cleanup();
    }
  });

  it("uses the generic empty sentence unless the host supplied a modelTargetsSkip label", () => {
    const { unmount } = renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    expect(screen.getByText(NO_DESTINATIONS_LABEL)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Fallback settings" }),
    ).toBeDefined();
    unmount();

    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [],
        // `family-unmatched`, not `no-group`, and the swap is deliberate.
        //
        // This case is about the wire contract: a host-supplied `label` beats
        // the client's generic sentence. `no-group` used to be the example and
        // is now the ONE carve-out from it - it describes an absence rather
        // than a candidate, and the host cannot write its sentence because that
        // sentence has to name the chat ("Claude Code · default") while the
        // host names tuples `claude/default`. So the rule this case pins is
        // demonstrated on a reason that still obeys it, and the carve-out plus
        // its own boundary are pinned in "the no-destination empty state"
        // below. Using the carved-out reason here would have made this case a
        // test of the exception rather than of the rule.
        modelTargetsSkip: fallbackSkip({
          reason: "family-unmatched",
          label: "<host words>",
        }),
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    expect(screen.getByText("<host words>")).toBeDefined();
    // Falsification: render NO_DESTINATIONS_LABEL unconditionally and the verbatim assertion must go red.
    expect(screen.queryByText(NO_DESTINATIONS_LABEL)).toBeNull();
  });

  it("renders emptyStateActions only when both lists are empty", () => {
    const marker = <span>{EMPTY_ACTIONS_MARKER}</span>;
    const { unmount } = renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: marker,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    expect(screen.getByText(EMPTY_ACTIONS_MARKER)).toBeDefined();
    unmount();

    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "work-profile",
            label: "work-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: marker,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    expect(screen.queryByText(EMPTY_ACTIONS_MARKER)).toBeNull();
  });

  // F12: the prior version of this test only compared an EMPTY response
  // (both arrays length 0) against a response with one selectable row. That
  // pair cannot tell "there are no rows" from "there are rows and none of
  // them can be picked" - and the empty-state rule (`hasSelectableRow` in
  // `fallback-destination-menu.tsx`) is written against the second fact, not
  // the first. A regression that reverted the gate to `hasRows` would still
  // pass the old test.
  it("treats a nonempty but ALL-DISABLED response as the empty state, not the has-rows state", () => {
    const marker = <span>{EMPTY_ACTIONS_MARKER}</span>;
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "dead-profile",
            label: "dead-account",
            severity: "ok",
            usedPercent: 10,
            selectable: false,
            skip: null,
          }),
        ],
        modelTargets: [
          modelRow({
            harnessId: "codex",
            modelFamily: "gpt",
            model: null,
            reasoningEffort: null,
            severity: "ok",
            usedPercent: 10,
            target: null,
            selectable: false,
            skip: null,
          }),
        ],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: marker,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    // The empty-state sentence and the caller's actions render...
    expect(screen.getByText(NO_SELECTABLE_DESTINATIONS_LABEL)).toBeDefined();
    expect(screen.getByText(EMPTY_ACTIONS_MARKER)).toBeDefined();
    // ...and so do the rows themselves, underneath - each disabled row still
    // carries the host's own reason for being unusable (the "still render
    // underneath" branch this file's own comment describes).
    expect(screen.getByText("dead-account")).toBeDefined();
    // Falsification: change `!hasSelectableRow` back to `!hasRows` in
    // `fallback-destination-menu.tsx`'s `MenuBody` and the first two
    // assertions go red - a nonempty, all-disabled response would then take
    // the has-rows branch and render no empty-state sentence, no marker.
  });

  it("suppresses the listTargets fetch while preparing, not just the rows", () => {
    listHarness.data = listed({
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [
        profileRow({
          profileId: "hidden",
          label: "should-not-render-while-preparing",
          severity: "ok",
          usedPercent: 10,
          selectable: true,
          skip: null,
        }),
      ],
      modelTargets: [],
      modelTargetsSkip: null,
    });
    renderMenu({
      data: listHarness.data,
      open: true,
      preparing: true,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();
    expect(screen.queryByText("should-not-render-while-preparing")).toBeNull();
    // Falsification: change enabled: open && !preparing to enabled: open and the never-issued assertion must go red.
    expect(listHarness.calls.every((call) => !call.enabled)).toBe(true);
  });

  // The dangerous reopen `MenuBody`'s own doc calls out: a reopen inside
  // `gcTime` resolves `status: "success"` carrying the PREVIOUS open's rows on
  // the very first render, with a fresh fetch still in flight - `isPending`
  // reads false, `data` is defined, and only `isFetching` says the rows are
  // stale. Without a harness that can express `isFetching: true` beside real
  // `data`, nothing in this file could ever put the component in that state.
  it("keeps retained rows off screen and the announcement region silent while a reopen's refetch is in flight", () => {
    listHarness.isPending = false;
    listHarness.isFetching = true;
    renderMenu({
      data: listed({
        failedTuple: FAILED_CLAUDE_TUPLE,
        profileTargets: [
          profileRow({
            profileId: "work-profile",
            label: "stale-retained-account",
            severity: "ok",
            usedPercent: 10,
            selectable: true,
            skip: null,
          }),
        ],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
      open: true,
      preparing: false,
      picking: false,
      refusal: null,
      header: null,
      emptyStateActions: null,
      onPick: () => undefined,
      onOpenChange: () => undefined,
    });
    // Falsification: drop `|| isFetching` from MenuBody's loading gate in
    // `fallback-destination-menu.tsx` - the retained row would then render.
    expect(screen.getByText(FINDING_DESTINATIONS_LABEL)).toBeDefined();
    expect(screen.queryByText("stale-retained-account")).toBeNull();
    // And the live region stays silent, per `menuStatusAnnouncement`'s
    // `isFetching` guard - not the "N destinations" count computed against
    // the retained rows.
    const [, announcement] = screen.getAllByRole("status");
    expect(announcement.textContent).toBe("");
  });

  it("keeps an inline refusal on screen while the menu stays open, and closes on applied", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackDestinationMenu
          triggerLabel="Open destinations"
          triggerDisabled={false}
          header={null}
          selector={{
            kind: "traversal",
            traversalId: "traversal-dest",
            revision: 8,
          }}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          client={null}
          open
          onOpenChange={onOpenChange}
          onPick={() => undefined}
          picking={false}
          preparing={false}
          refusal="This chat already resumed."
          emptyStateActions={null}
        />
      </TabHostProvider>,
    );
    listHarness.data = listed({
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [
        profileRow({
          profileId: "work-profile",
          label: "work-account",
          severity: "ok",
          usedPercent: 10,
          selectable: true,
          skip: null,
        }),
      ],
      modelTargets: [],
      modelTargetsSkip: null,
    });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackDestinationMenu
          triggerLabel="Open destinations"
          triggerDisabled={false}
          header={null}
          selector={{
            kind: "traversal",
            traversalId: "traversal-dest",
            revision: 8,
          }}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          client={null}
          open
          onOpenChange={onOpenChange}
          onPick={() => undefined}
          picking={false}
          preparing={false}
          refusal="This chat already resumed."
          emptyStateActions={null}
        />
      </TabHostProvider>,
    );
    expect(screen.getByText("This chat already resumed.")).toBeDefined();
    expect(screen.getByText("work-account")).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackDestinationMenu
          triggerLabel="Open destinations"
          triggerDisabled={false}
          header={null}
          selector={{
            kind: "traversal",
            traversalId: "traversal-dest",
            revision: 8,
          }}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          client={null}
          open={false}
          onOpenChange={onOpenChange}
          onPick={() => undefined}
          picking={false}
          preparing={false}
          refusal={null}
          emptyStateActions={null}
        />
      </TabHostProvider>,
    );
    expect(screen.queryByText("This chat already resumed.")).toBeNull();
  });
});

describe("FallbackGraceMenu", () => {
  beforeEach(() => {
    listHarness.calls = [];
    listHarness.data = listed({
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [
        profileRow({
          profileId: "work-profile",
          label: "work-account",
          severity: "ok",
          usedPercent: 10,
          selectable: true,
          skip: null,
        }),
      ],
      modelTargets: [
        modelRow({
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: TARGET_CODEX_TUPLE.model,
          reasoningEffort: null,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    listHarness.isPending = false;
    listHarness.isFetching = false;
    listHarness.isError = false;
    actionHarness.mutate.mockReset();
    leaseHarness.hold.mockReset();
    leaseHarness.release.mockReset();
    leaseHarness.lease = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("takes a hold on open and releases on close", () => {
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    expect(leaseHarness.hold).toHaveBeenCalledWith("traversal-dest");
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    expect(leaseHarness.release).toHaveBeenCalledTimes(1);
  });

  it("does not list until the lease is held and the DTO reports choosing", () => {
    const pendingHold = holdPending("hold");
    const choosing = holdPending("choosing");
    leaseHarness.lease = graceLease({ token: null, status: "pending" });
    const { rerender } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={pendingHold}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();
    expect(screen.queryByText("work-account")).toBeNull();

    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={pendingHold}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    // Falsification: drop the pending.state !== "choosing" half and the held+hold case must go red.
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();
    expect(screen.queryByText("work-account")).toBeNull();

    leaseHarness.lease = graceLease({ token: null, status: "pending" });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={choosing}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();
    expect(screen.queryByText("work-account")).toBeNull();

    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={choosing}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("work-account")).toBeDefined();
  });

  // This file mocks `use-fallback-choice-lease` wholesale (see the
  // `vi.mock` at the top), so nothing here can call the real
  // `fallbackHoldForChoice` - it only renders whatever shape `leaseHarness`
  // is set to. The GATE this narrative depends on
  // (`pending.state !== "hold" && pending.state !== "choosing"` in
  // `chat-session-store.ts`) is falsified in
  // `chat-session-store-choice-lease.test.ts`'s "reopening during a pending
  // release reuses the in-flight hold instead of minting a second one", NOT
  // here: that test calls `store.getState().fallbackHoldForChoice(...)`
  // directly, with no mock between it and the code. An ablation of that gate
  // reddens the store test and leaves THIS test green, because this test
  // never asks the store to produce the lease shape below - it types it in.
  // Reader, if you came here after watching that ablation and finding this
  // file unmoved: that is expected, not a hole in the store's pin - it is
  // this file's known limit, stated so nobody "fixes" it by mocking harder.
  //
  // What this test DOES pin: given that shape, the render (MF01's
  // symptom - a menu stuck on "Pausing the countdown…") actually clears.
  // MF01 was a menu that stayed on that label forever after a
  // close-before-ack, because the DTO never goes back to `hold` once the host
  // has taken the freeze - it reads `choosing` for the rest of the traversal.
  it("reopening after a close-before-ack reaches destination rows instead of staying on the pausing label", () => {
    const choosing = holdPending("choosing");
    // The shape `chat-session-store-choice-lease.test.ts`'s reopen case
    // proves the store returns: the withdrawn obligation (`releaseRequested`
    // back to `false`) surfaces to this hook as the same in-flight `pending`
    // lease it started with - not a fresh one. This file cannot verify that
    // claim itself; see the comment above.
    leaseHarness.lease = graceLease({ token: null, status: "pending" });
    const { rerender } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={choosing}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    listHarness.calls = [];
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    // Negative half: `preparing` suppresses the FETCH, not just the rows -
    // reopening onto a still-pending reacquired lease must not query targets
    // for a window it cannot yet present.
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();
    // Explicit, rather than relying on `getByText`'s implicit at-most-one
    // check: this is the pin for the sr-only live region that used to MIRROR
    // this exact sentence into a second element. Falsification: reintroduce a
    // `<div role="status" aria-live="polite" className="sr-only">` echoing
    // `PAUSING_COUNTDOWN_LABEL` in `fallback-destination-menu.tsx` and this
    // goes red (length 2).
    expect(screen.getAllByText(PAUSING_COUNTDOWN_LABEL)).toHaveLength(1);
    expect(screen.queryByText("work-account")).toBeNull();
    expect(listHarness.calls.length).toBeGreaterThan(0);
    expect(listHarness.calls.every((call) => !call.enabled)).toBe(true);

    // The ack the reused in-flight request was always going to get.
    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={choosing}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    // Falsification: change `preparing` at fallback-card-menus.tsx from
    // `lease?.status !== "held" || pending.state !== "choosing"` to
    // `pending.state !== "hold"` (the pre-fix reading) - the DTO is
    // `choosing`, never `hold`, for the rest of this traversal, so `preparing`
    // is permanently `true` and this goes red (the label never clears, the
    // row never appears).
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("work-account")).toBeDefined();
  });

  it("shows the refused-hold sentence once, issues no listTargets fetch, and draws no rows", () => {
    leaseHarness.lease = graceLease({ token: null, status: "refused" });
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    listHarness.calls = [];
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    const labels = screen.getAllByText(COUNTDOWN_NOT_PAUSED_LABEL);
    // Falsification: drop the || preparing from the top-level refusal-line guard and this must go red.
    expect(labels).toHaveLength(1);
    // Falsification: restore !refusedHold && to the preparing expression and this must go red.
    expect(screen.queryByText("work-account")).toBeNull();
    expect(screen.queryByText("Codex · gpt-5")).toBeNull();
    expect(listHarness.calls.length).toBeGreaterThan(0);
    expect(listHarness.calls.every((call) => !call.enabled)).toBe(true);
  });

  // The popover renders exactly two `role="status"` elements: the refusal
  // region (DOM order 0) and the readiness/announcement region (DOM order
  // 1). Neither carries an accessible name of its own, so a name-scoped
  // `getByRole` cannot select between them - positional indexing is the only
  // option. Positional indexing is exactly the kind of selector that fails
  // SILENTLY in the direction that matters: add a third status region
  // anywhere in the popover and index-1 keeps resolving to SOME element,
  // never throwing, while now measuring the wrong one. The `toHaveLength(2)`
  // below is the precondition check that closes that gap - every call site
  // that asks for either region gets it for free.
  function statusRegions(): readonly [HTMLElement, HTMLElement] {
    const regions = screen.getAllByRole("status");
    // The exact-2 guard every caller inherits. It is this assertion, not a
    // follow-up `=== undefined` throw, that fails the test when a third region
    // appears or one goes missing - and that throw was unreachable anyway,
    // since with `noUncheckedIndexedAccess` off both destructured elements are
    // typed non-nullish.
    expect(regions).toHaveLength(2);
    const [refusal, announcement] = regions;
    return [refusal, announcement];
  }

  function refusalRegion(): HTMLElement {
    return statusRegions()[0];
  }

  function announcementRegion(): HTMLElement {
    return statusRegions()[1];
  }

  // F25 (i): the refusal region must stay IN THE ACCESSIBILITY TREE from open,
  // empty or not - `empty:sr-only`, not `empty:hidden` - so assistive tech is
  // already observing it when the first refusal actually arrives. This
  // environment runs under plain jsdom with no stylesheet loaded (see
  // `vitest.config.ts`), so `display: none` is not something a computed-style
  // query can observe here; the class name itself is the falsifiable surface.
  it("keeps the refusal's live region present (empty:sr-only, not empty:hidden) even with nothing to say", () => {
    leaseHarness.lease = graceLease({ token: null, status: "pending" });
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    const refusal = refusalRegion();
    expect(refusal.textContent).toBe("");
    // Falsification: put `empty:hidden` back on this element - the class
    // string flips and this goes red.
    expect(refusal.className).toContain("empty:sr-only");
    expect(refusal.className).not.toContain("empty:hidden");
  });

  // F25 (ii): a failed or stale listing now reaches the sr-only announcement
  // region too, not just the visible body - both sentences appear TWICE in
  // the document (once visible, once in the live region) BY DESIGN. Scoped
  // via `within(announcementRegion())` rather than a document-wide
  // `getAllByText(...).toHaveLength(2)`: the old form would stay green even
  // if `menuStatusAnnouncement` stopped emitting the sentence entirely, so
  // long as some OTHER two elements in the popover happened to say the same
  // words - it never actually looked inside the live region.
  it("announces a failed listing in the live region specifically, alongside the visible line", () => {
    listHarness.isError = true;
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    leaseHarness.lease = graceLease({ token: "lease-token-1", status: "held" });
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    // Falsification: restore the `isError` arm of `menuStatusAnnouncement` to
    // `return ""` and this goes red - the live region itself would be empty,
    // whatever the visible body still says.
    expect(
      within(announcementRegion()).getByText(HOST_UNREACHABLE_LABEL),
    ).toBeDefined();
    // The visible copy still exists, outside the live region.
    expect(screen.getAllByText(HOST_UNREACHABLE_LABEL)).toHaveLength(2);
  });

  it("announces a stale (traversal-advanced) listing in the live region specifically, alongside the visible line", () => {
    listHarness.isError = false;
    listHarness.data = listTargetsResponse({
      outcome: "traversal_advanced",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [],
      modelTargetsSkip: null,
    });
    leaseHarness.lease = graceLease({ token: "lease-token-1", status: "held" });
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    // Falsification: restore the stale-listing arm of `menuStatusAnnouncement`
    // (the `describeListTargetsOutcome` branch) to `return ""` and this goes
    // red - the region would be empty.
    expect(
      within(announcementRegion()).getByText("This chat already resumed."),
    ).toBeDefined();
    expect(screen.getAllByText("This chat already resumed.")).toHaveLength(2);
  });

  // F25 (iii): the readiness sentence itself - `menuStatusAnnouncement`'s
  // "N destinations available to choose." branch - had no assertion anywhere
  // in this file. `beforeEach` seeds one selectable profile row and one
  // selectable model row, so the expected count is 2, not 1: a fixture where
  // only one row exists could not tell the plural branch from the singular
  // one, which is exactly the kind of off-by-one this sentence can hide.
  it("announces readiness with the selectable count, inside the live region", () => {
    leaseHarness.lease = graceLease({ token: "lease-token-1", status: "held" });
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    // Falsification: change the plural branch's template to hardcode "1" and
    // this goes red - the fixture's selectable count is 2, not 1.
    expect(
      within(announcementRegion()).getByText(
        "2 destinations available to choose.",
      ),
    ).toBeDefined();
  });

  // F25 (iv): a genuine BEFORE/AFTER transition inside the announcement
  // region, not just an end-state snapshot - loading (silent, per
  // `menuStatusAnnouncement`'s `isPending` guard) to ready (the count). A
  // snapshot alone cannot tell "this region announces readiness" from "this
  // region always said this, independent of the fetch".
  it("transitions the live region from silent (loading) to the readiness count once the listing arrives", () => {
    listHarness.isPending = true;
    leaseHarness.lease = graceLease({ token: "lease-token-1", status: "held" });
    const { rerender } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    // Before: still loading, the region is silent.
    expect(announcementRegion().textContent).toBe("");
    const focusedBeforeTransition = document.activeElement;

    // The listing settles. The mocked `useFallbackListTargets` reads
    // `listHarness` fresh on every render, so flipping the flag and
    // re-rendering the SAME element tree is what a real query settling looks
    // like from this component's perspective.
    listHarness.isPending = false;
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    // Falsification: change the `isPending` guard's early `return ""` to
    // instead return the readiness sentence unconditionally, and the "before"
    // assertion above goes red instead - proving this test actually
    // distinguishes the two states rather than only checking the final one.
    expect(
      within(announcementRegion()).getByText(
        "2 destinations available to choose.",
      ),
    ).toBeDefined();
    // Contract: the swap is ANNOUNCED, not focus-moving. Nothing above this
    // point can have moved focus off whatever it was.
    expect(document.activeElement).toBe(focusedBeforeTransition);
  });

  // F25 (v): the OTHER live region's own before/after transition - silent
  // (no refusal established yet) to the refused-hold sentence, once the lease
  // comes back `status: "refused"`. This is "refused" in the codebase's own
  // vocabulary (`FallbackChoiceLease["status"] === "refused"`), and it is the
  // FIRST `role="status"` region (index 0), not the announcement region above.
  it("transitions the refusal region from silent to the refused-hold sentence, without moving focus", () => {
    leaseHarness.lease = graceLease({ token: null, status: "pending" });
    const { rerender } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    const refusal = refusalRegion();
    // Before: no refusal has been established - a pending lease is not yet a
    // refusal, so this region has nothing to say.
    expect(refusal.textContent).toBe("");
    const focusedBeforeTransition = document.activeElement;

    leaseHarness.lease = graceLease({ token: null, status: "refused" });
    rerender(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    // After: same DOM element (the refusal region persists across the
    // transition per F25 (i) - it is never unmounted), now carrying the
    // refused-hold sentence.
    // Falsification: stop deriving `refusal` from `lease?.status ===
    // "refused"` in `fallback-card-menus.tsx` and this goes red - the region
    // stays silent through the transition.
    expect(refusal.textContent).toBe(COUNTDOWN_NOT_PAUSED_LABEL);
    // Contract: announced, not focus-moving.
    expect(document.activeElement).toBe(focusedBeforeTransition);
  });

  it("sends chooseTarget with the lease token on a grace pick", () => {
    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    expect(
      actionHarness.mutate.mock.calls.length,
      "chooseTarget must be called",
    ).toBeGreaterThan(0);
    const first = actionHarness.mutate.mock.calls[0];
    expect(first[0]).toEqual({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      traversalId: "traversal-dest",
      revision: 8,
      target: TARGET_CODEX_TUPLE,
      leaseToken: "lease-token-1",
    });
  });

  it("keeps the menu open with inline refusal copy, and closes on applied", () => {
    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    actionHarness.mutate.mockImplementation(
      (
        _vars: unknown,
        opts: {
          readonly onSuccess:
            | ((response: { readonly outcome: string }) => void)
            | undefined;
        },
      ) => {
        if (opts.onSuccess !== undefined) {
          opts.onSuccess({ outcome: "traversal_advanced" });
        }
      },
    );
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.getByText("This chat already resumed.")).toBeDefined();
    expect(screen.getByText("work-account")).toBeDefined();

    cleanup();
    actionHarness.mutate.mockImplementation(
      (
        _vars: unknown,
        opts: {
          readonly onSuccess:
            | ((response: { readonly outcome: string }) => void)
            | undefined;
        },
      ) => {
        if (opts.onSuccess !== undefined) {
          opts.onSuccess({ outcome: "applied" });
        }
      },
    );
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.queryByText("This chat already resumed.")).toBeNull();
    expect(screen.queryByText("work-account")).toBeNull();
  });

  // A released chat session stays warm ~10 minutes, so closing the tile over
  // an open menu never fires `onOpenChange(false)` - the popover just
  // disappears with the stream still connected. Without the unmount cleanup
  // below, that leaves the host holding a frozen window with no UI anywhere
  // left to give it back. `release()` here is the same
  // `fallbackReleaseChoice` an explicit close calls, so the frame it sends
  // (token, traversalId) is already pinned by the store-level suite; this
  // pins only whether the component calls it, and when.
  it("releases on unmount when the popover was open", () => {
    leaseHarness.lease = graceLease({
      token: "lease-token-1",
      status: "held",
    });
    const { unmount } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("choosing")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose differently…" }),
    );
    expect(leaseHarness.release).not.toHaveBeenCalled();

    // Falsification: delete the `useEffect(() => () => { if (openRef.current)
    // releaseRef.current(); }, [])` cleanup in fallback-card-menus.tsx and
    // this must go red (release never called on unmount).
    unmount();
    expect(leaseHarness.release).toHaveBeenCalledTimes(1);
  });

  // Negative half of the case above: without the `openRef.current` guard, an
  // unconditional release-on-unmount would fire for every card that ever
  // mounted, including one whose menu was never opened - resuming a window
  // this component never held anything on.
  it("does not release on unmount when the popover was never opened", () => {
    leaseHarness.lease = null;
    const { unmount } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackGraceMenu
          pending={holdPending("hold")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    // Falsification: change the cleanup's `if (openRef.current) release()` to
    // an unconditional `releaseRef.current()` and this goes red (release
    // called despite the menu never having been opened).
    unmount();
    expect(leaseHarness.release).not.toHaveBeenCalled();
  });
});

describe("FallbackWaitingMenu", () => {
  beforeEach(() => {
    // Reset every harness flag explicitly rather than relying on run order:
    // `listHarness` is module-level state shared with `FallbackGraceMenu`
    // above, and without resetting `isPending`/`isError` here too, this
    // suite would silently inherit whatever the grace suite's last test left
    // behind instead of standing on its own.
    listHarness.calls = [];
    listHarness.isPending = false;
    listHarness.isFetching = false;
    listHarness.isError = false;
    listHarness.data = listed({
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        modelRow({
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: TARGET_CODEX_TUPLE.model,
          reasoningEffort: null,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    actionHarness.mutate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // F10 (MF06): the header used to say only the reset time, so "Switch
  // instead…" read as changing a setting for the NEXT message - nothing on
  // screen said the pick replays the failed message right now, starts a
  // fresh provider session, and takes the queue with it. The consequence
  // sentence must be visible BEFORE any destination row is clicked, which is
  // why both assertions below happen right after opening the menu.
  it("names the reset time in the header alongside the switch consequences, and drops the reset fragment when deadline is null", () => {
    const at = new Date(2026, 5, 15, 15, 0, 0).getTime();
    // `queuedItemsMoving: 0` hides the queue clause (`queuedMessagesMovingText`
    // returns `null` at zero) - this pins the base sentence, not the queue
    // count. `chat-composer-fallback-banners.test.tsx` already covers the
    // count wording.
    const consequences =
      "Replays this message on the destination you pick. Starts a fresh session from this transcript.";
    const { unmount } = render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackWaitingMenu
          pending={pendingFallback({
            state: "waiting",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: null,
            impendingAction: null,
            deadline: at,
            attempt: 1,
            maxAttempts: 1,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-dest",
            revision: 8,
          })}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch instead…" }));
    // Falsification: revert `waitingMenuHeader` to return only
    // `Resumes at ${formatClockTime(deadline)} unless you pick something.`
    // (drop the trailing `${consequences}`) and this goes red.
    expect(
      screen.getByText(
        `Resumes at ${formatClockTime(at)} unless you pick something. ${consequences}`,
      ),
    ).toBeDefined();
    unmount();

    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackWaitingMenu
          pending={pendingFallback({
            state: "waiting",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: null,
            impendingAction: null,
            deadline: null,
            attempt: 1,
            maxAttempts: 1,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-dest",
            revision: 8,
          })}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch instead…" }));
    // With no deadline the header must be the consequence sentence ALONE - no
    // dangling "Resumes at" fragment with nothing to fill it.
    expect(screen.getByText(consequences)).toBeDefined();
    expect(screen.queryByText(/Resumes at/)).toBeNull();
  });

  // The policy's wait cap reaches seven days, so the header's resume time
  // needs its weekday once it is that far out - the bare clock time alone
  // would name the wrong day.
  it("names the header's resume time with its weekday once it is a day or more away", () => {
    const at = Date.now() + 4 * 24 * 60 * 60_000;
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackWaitingMenu
          pending={pendingFallback({
            state: "waiting",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: null,
            impendingAction: null,
            deadline: at,
            attempt: 1,
            maxAttempts: 1,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-dest",
            revision: 8,
          })}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch instead…" }));
    const replays = "Replays this message on the destination you pick.";
    const freshSession = "Starts a fresh session from this transcript.";
    const resumesAtLabel = formatResetDateTime(at);
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this reads the bare clock time instead of the weekday-qualified form.
    const header =
      `Resumes at ${resumesAtLabel} unless you pick something. ` +
      `${replays} ${freshSession}`;
    expect(screen.getByText(header)).toBeDefined();
  });

  // F10: the test above only ever used `queuedItemsMoving: 0`, which takes
  // the SAME "consequences alone" branch as "queue not mentioned" - it cannot
  // tell a genuine zero-queue apart from a count the header forgot to state.
  // This pins the header with an actual queue in flight.
  it("names the queued-message count in the header before a pick, when messages are queued", () => {
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackWaitingMenu
          pending={pendingFallback({
            state: "waiting",
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: null,
            impendingAction: null,
            deadline: null,
            attempt: 1,
            maxAttempts: 1,
            queuedItemsMoving: 3,
            siblingSwitching: 0,
            traversalId: "traversal-dest",
            revision: 8,
          })}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch instead…" }));
    // Falsification: hardcode `waitingMenuHeader`'s call to
    // `switchConsequencesText(0)` regardless of the real count, and this goes
    // red - the header would then read the same as the zero-queue case above.
    expect(
      screen.getByText(
        "Replays this message on the destination you pick. Starts a fresh session from this transcript. 3 queued messages will run on the new settings too.",
      ),
    ).toBeDefined();
  });

  it("sends chooseTarget with leaseToken null on a waiting pick", () => {
    render(
      <TabHostProvider hostId={HOST_ID}>
        <FallbackWaitingMenu
          pending={holdPending("waiting")}
          client={null}
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          canAct
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch instead…" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    expect(
      actionHarness.mutate.mock.calls.length,
      "chooseTarget must be called",
    ).toBeGreaterThan(0);
    const first = actionHarness.mutate.mock.calls[0];
    expect(first[0]).toEqual({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      traversalId: "traversal-dest",
      revision: 8,
      target: TARGET_CODEX_TUPLE,
      leaseToken: null,
    });
  });

  /**
   * The rung-level `no-group` empty state - the commonest empty menu there is,
   * and the one whose sentence a host-side string cannot write.
   *
   * The host sends the REASON and a degraded label; the words a user reads are
   * resolved here, because the provider display name lives on this side. So
   * these cases pin the substitution (the identity replaces the label) and its
   * boundary (every OTHER reason still renders the label verbatim, which is the
   * wire contract this surface must not quietly stop honouring).
   */
  describe("the no-destination empty state", () => {
    const DEFAULT_SHAPED_TUPLE = chatRunSettings({
      harnessId: "claude",
      model: "default",
      profileId: null,
    });

    function renderEmptyMenu(skip: FallbackTargetSkip | null) {
      renderMenu({
        data: listed({
          failedTuple: DEFAULT_SHAPED_TUPLE,
          // BOTH lists empty, which is what the defect actually looks like once
          // the chat's only account is the one that failed: no rows to explain
          // themselves, so this line is the entire contents of the popover.
          profileTargets: [],
          modelTargets: [],
          modelTargetsSkip: skip,
        }),
        open: true,
        preparing: false,
        picking: false,
        refusal: null,
        header: null,
        emptyStateActions: null,
        onPick: vi.fn(),
        onOpenChange: () => undefined,
      });
    }

    it("names the chat instead of repeating the host's degraded label", () => {
      renderEmptyMenu({
        reason: "no-group",
        // The host's own words, which a current client is expected to REPLACE.
        // Kept deliberately distinct from anything the identity sentence says,
        // so "the label was rendered" and "the sentence was rendered" cannot
        // both be satisfied by one string.
        label: "No other model is set up as equivalent to this one.",
      });
      expect(
        screen.getByText("No other model is set up for Claude Code · default"),
      ).toBeDefined();
      expect(
        screen.queryByText(
          "No other model is set up as equivalent to this one.",
        ),
      ).toBeNull();
      // The generic fallbacks must NOT also appear - the specific sentence
      // replaces them rather than joining them.
      expect(screen.queryByText(NO_DESTINATIONS_LABEL)).toBeNull();
      expect(screen.queryByText(NO_SELECTABLE_DESTINATIONS_LABEL)).toBeNull();
    });

    it("renders the host's label verbatim for every other reason", () => {
      // The boundary case, and the one a careless implementation breaks: the
      // wire contract is that `label` is always safe to show and that this
      // surface does not re-word a reason. Only `no-group` is carved out, and
      // only because it is the one reason that describes an ABSENCE rather
      // than a candidate.
      renderEmptyMenu({
        reason: "already-tried",
        label: "already tried",
      });
      expect(screen.getByText("already tried")).toBeDefined();
      expect(screen.queryByText(/No other model is set up for/)).toBeNull();
    });

    it("falls back to the host's label when no failed tuple came back", () => {
      // `failedTuple: null` leaves nothing to name. The host's label is then
      // the better of the two - a sentence trailing off into an empty identity
      // is worse than a generic one.
      renderMenu({
        data: listed({
          failedTuple: null,
          profileTargets: [],
          modelTargets: [],
          modelTargetsSkip: {
            reason: "no-group",
            label: "No other model is set up as equivalent to this one.",
          },
        }),
        open: true,
        preparing: false,
        picking: false,
        refusal: null,
        header: null,
        emptyStateActions: null,
        onPick: vi.fn(),
        onOpenChange: () => undefined,
      });
      expect(
        screen.getByText("No other model is set up as equivalent to this one."),
      ).toBeDefined();
      expect(screen.queryByText(/No other model is set up for/)).toBeNull();
    });
  });
});
