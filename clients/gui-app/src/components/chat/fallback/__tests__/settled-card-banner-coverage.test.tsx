import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { FallbackRungRefusalDetail } from "@traycer/protocol/host/chat-fallback";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import type { ProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FallbackManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import type { RoutingDestinationPicker } from "@/components/chat/fallback/routing-destination-picker";
import {
  useComposerRateLimitAdvisory,
  type ComposerBannerAccount,
} from "@/components/chat/fallback/use-settled-routing-card-offers-switch";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  lastFailedAttempt,
  pendingFallback,
  providerProfile,
} from "./fallback-fixtures";

/**
 * The settled card's action row and the composer's rate-limit advisory, over
 * ONE session store: the composer withholds its "Switch to" banner exactly
 * while the card draws its own "Switch to…". Neither half's own suite can see
 * them disagree, so both render here and every case asserts both halves.
 */

const EPIC_ID = "epic-coverage";
const CHAT_ID = "chat-coverage";
const HOST_ID = "host-coverage";
const TURN_ID = "turn-limited";
const NEXT_TURN_ID = "turn-limited-2";
const USER_MESSAGE_ID = "user-msg-limited";
const RESETS_AT = Date.now() + 60 * 60_000;

interface MockRungResponse {
  readonly outcome: string;
  readonly detail: FallbackRungRefusalDetail | null;
}

/** What the announcer is asked to speak. */
interface PublishedOutcome {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly text: string;
}

interface SessionSlice {
  lastFailedAttempt: LastFailedAttempt | undefined;
  pendingFallback: PendingFallback | undefined;
  access: {
    readonly role: "owner" | "viewer";
    readonly ownerUserId: string;
    readonly canAct: boolean;
  } | null;
  connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
  chat: { readonly settings: ChatRunSettings | null } | null;
  messages: ReadonlyArray<Message>;
  publishConfirmedManualFallbackAction: (input: unknown) => void;
  publishUnattendedFallbackOutcome: (input: unknown) => void;
}

const harness = vi.hoisted(() => {
  // What the announcer was asked to speak, in order.
  const publishedUnattended: PublishedOutcome[] = [];
  const isPublishedOutcome = (input: unknown): input is PublishedOutcome =>
    typeof input === "object" &&
    input !== null &&
    "hostId" in input &&
    typeof input.hostId === "string" &&
    "epicId" in input &&
    typeof input.epicId === "string" &&
    "chatId" in input &&
    typeof input.chatId === "string" &&
    "text" in input &&
    typeof input.text === "string";
  // The slice carries both publishers for the reason the manual-rungs suite
  // gives: the production hooks reach them through `handle.store.getState()`,
  // so a slice without them fails inside production code wearing a fixture gap.
  const initialSlice = (): SessionSlice => ({
    lastFailedAttempt: undefined,
    pendingFallback: undefined,
    access: { role: "owner", ownerUserId: "owner-1", canAct: true },
    connectionStatus: "open",
    chat: null,
    messages: [],
    publishConfirmedManualFallbackAction: (): void => undefined,
    publishUnattendedFallbackOutcome: (input: unknown): void => {
      if (isPublishedOutcome(input)) publishedUnattended.push(input);
    },
  });
  let state: SessionSlice = initialSlice();
  const listeners = new Set<() => void>();
  const store = {
    getState: (): SessionSlice => state,
    getInitialState: (): SessionSlice => initialSlice(),
    // MERGES, like zustand's own `setState`.
    setState: (next: Partial<SessionSlice>): SessionSlice => {
      state = { ...state, ...next };
      for (const listener of listeners) {
        listener();
      }
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store,
    initialSlice,
    mutate: vi.fn(),
    publishedUnattended,
    mutationResult: null as MockRungResponse | null,
    // Deferred mode leaves a press undelivered, so it stays pending.
    deferResponses: false,
    pendingResponses: [] as Array<(result: MockRungResponse) => void>,
    pickerProps: [] as ComponentProps<typeof RoutingDestinationPicker>[],
  };
});

vi.mock("sonner", () => ({ toast: vi.fn() }));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

// One mock serves both modules: the card and the composer's glue each read the
// session through this hook.
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({ store: harness.store }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useIsMutating: () => 0,
}));

// The chooser has its own suite. Here it is a button that goes quiet the way
// the real trigger does.
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (
    props: ComponentProps<typeof RoutingDestinationPicker>,
  ) => {
    harness.pickerProps.push(props);
    return (
      <button type="button" disabled={props.triggerDisabled || !props.canAct}>
        {props.triggerLabel}
      </button>
    );
  },
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: EPIC_ID }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ label: "Surya's MacBook" }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    args: {
      readonly onSuccess:
        | ((response: MockRungResponse, variables: unknown) => void)
        | undefined;
    },
  ) => {
    const [state, setState] = useState<{
      readonly isPending: boolean;
      readonly variables: { readonly rung: string } | undefined;
    }>({ isPending: false, variables: undefined });
    return {
      mutate: (
        vars: { readonly rung: string },
        opts:
          | {
              readonly onSuccess:
                | ((response: MockRungResponse, variables: unknown) => void)
                | undefined;
            }
          | undefined,
      ) => {
        harness.mutate(vars);
        setState({ isPending: true, variables: vars });
        const deliver = (result: MockRungResponse): void => {
          setState({ isPending: false, variables: undefined });
          if (args.onSuccess !== undefined) {
            args.onSuccess(result, vars);
          }
          if (opts !== undefined && opts.onSuccess !== undefined) {
            opts.onSuccess(result, vars);
          }
        };
        if (harness.deferResponses) {
          harness.pendingResponses.push(deliver);
          return;
        }
        const result = harness.mutationResult;
        if (result === null) return;
        deliver(result);
      },
      isPending: state.isPending,
      variables: state.variables,
    };
  },
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

/** The account the composer's banner speaks about: the failed tuple's own. */
const ACCOUNT: ComposerBannerAccount = {
  harnessId: FAILED_CLAUDE_TUPLE.harnessId,
  profileId: FAILED_CLAUDE_TUPLE.profileId,
};

const CURRENT_PROFILE = providerProfile({
  profileId: "failed01-profile",
  kind: "managed",
  label: "failed01",
  authenticated: true,
});

const VISIBLE_PROMPT: ProfileRateLimitSwitchPrompt = {
  kind: "visible",
  warningKey: "warning-key",
  providerId: "claude-code",
  severity: "hard_limit",
  limitedFamilies: [],
  current: CURRENT_PROFILE,
  profiles: [CURRENT_PROFILE],
  destinations: [],
  primaryTarget: null,
  probeTarget: null,
  dismiss: () => undefined,
};

type Rung = "retry" | "switch" | "wait_once";

function attemptFor(input: {
  readonly turnId: string;
  readonly eligibleRungs: ReadonlyArray<Rung>;
  readonly failedTuple: ChatRunSettings | null;
}): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: USER_MESSAGE_ID,
    turnId: input.turnId,
    failure: {
      reason: "rate_limit",
      resetsAt: RESETS_AT,
      resetsAtSource: "provider",
    },
    eligibleRungs: input.eligibleRungs,
    waitDisposition: "eligible",
    switchDisposition: input.eligibleRungs.includes("switch")
      ? "eligible"
      : "unknown",
    failedTuple: input.failedTuple,
  });
}

/** An assistant message of `turnId` whose top-level text block carries a receipt. */
function receiptMessage(turnId: string): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: `assistant-${turnId}`,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
    },
    blocks: [
      {
        blockId: `notice-${turnId}`,
        parentBlockId: null,
        status: "completed",
        timestamp: 2,
        type: "text",
        text: "Routing stopped.",
        providerNotice: {
          harnessId: "claude",
          noticeKind: "fallback_settled",
          tone: "info",
          title: "Routing stopped",
          message: null,
          details: [],
          metadata: null,
          receipt: { causeLabel: "Rate limit reached", steps: [] },
        },
      },
    ],
    timestamp: 3,
    turnId,
    usage: null,
  });
}

const ALL_RUNGS: ReadonlyArray<Rung> = ["retry", "switch", "wait_once"];

/** The state every case starts from; a case then moves the terms it is about. */
function seedSettledCard(): void {
  harness.store.setState({
    lastFailedAttempt: attemptFor({
      turnId: TURN_ID,
      eligibleRungs: ALL_RUNGS,
      failedTuple: FAILED_CLAUDE_TUPLE,
    }),
    messages: [receiptMessage(TURN_ID)],
  });
}

function AdvisoryProbe() {
  const advisory = useComposerRateLimitAdvisory({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    hostId: HOST_ID,
    account: ACCOUNT,
    prompt: VISIBLE_PROMPT,
    signedOut: false,
  });
  return (
    <span data-testid="advisory">{advisory === null ? "hidden" : "shown"}</span>
  );
}

/** The composer's advisory beside one transcript row per turn id. */
function Scene({ turnIds }: { readonly turnIds: ReadonlyArray<string> }) {
  return (
    <TabHostProvider hostId={HOST_ID}>
      <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
        <AdvisoryProbe />
        {turnIds.map((turnId) => (
          <FallbackManualRungActions key={turnId} turnId={turnId} />
        ))}
      </ChatTranscriptProvider>
    </TabHostProvider>
  );
}

function switchTrigger(): HTMLButtonElement | null {
  const element = screen.queryByRole("button", { name: "Switch to…" });
  if (element === null) return null;
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('expected "Switch to…" to be a button');
  }
  return element;
}

function advisoryText(): string | null {
  return screen.getByTestId("advisory").textContent;
}

/** Both halves of one moment: does the card draw its Switch, and does the banner show. */
function expectHalves(input: {
  readonly cardDrawsSwitch: boolean;
  readonly advisory: "shown" | "hidden";
}): void {
  expect(switchTrigger() !== null).toBe(input.cardDrawsSwitch);
  expect(advisoryText()).toBe(input.advisory);
}

function pressRetry(): void {
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
}

function refusal(kind: string, retryable: boolean): MockRungResponse {
  return {
    outcome: "rung_unavailable",
    detail: { kind, retryable, label: "The host's own sentence." },
  };
}

beforeEach(() => {
  harness.publishedUnattended.length = 0;
  harness.mutate.mockReset();
  harness.mutationResult = null;
  harness.deferResponses = false;
  harness.pendingResponses.length = 0;
  harness.pickerProps = [];
  // Reset to the initial slice: `setState` merges, so a case that moved a term
  // would otherwise leak it into the next.
  harness.store.setState(harness.initialSlice());
});

afterEach(() => {
  cleanup();
});

describe("the settled card's Switch and the composer's advisory over one session", () => {
  it("HEADLINE: a bare Retry the host refuses with message_changed removes the action row, and the advisory returns", () => {
    seedSettledCard();
    render(<Scene turnIds={[TURN_ID]} />);
    expectHalves({ cardDrawsSwitch: true, advisory: "hidden" });

    harness.mutationResult = refusal("message_changed", false);
    pressRetry();

    // The host did not replace lastFailedAttempt: the refusal is card-local.
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
  });

  describe("a bare Retry the host refuses", () => {
    interface RefusalCase {
      readonly name: string;
      readonly response: MockRungResponse;
      readonly cardDrawsSwitch: boolean;
    }
    const cases: ReadonlyArray<RefusalCase> = [
      ...[
        "turn_running",
        "routing_active",
        "worktree_missing",
        "no_workspace",
        "message_changed",
        "settings_missing",
      ].map((kind): RefusalCase => ({
        name: `${kind} (not retryable) leaves no Switch`,
        response: refusal(kind, false),
        cardDrawsSwitch: false,
      })),
      ...[
        "prelaunch_failed",
        "reset_passed",
        "no_verified_reset",
        "target_unusable",
        "host_unavailable",
        "storage_failed",
        "unknown",
      ].map((kind): RefusalCase => ({
        name: `${kind} (not retryable) keeps the Switch`,
        response: refusal(kind, false),
        cardDrawsSwitch: true,
      })),
      {
        name: "worktree_missing with retryable:true keeps every action",
        response: refusal("worktree_missing", true),
        cardDrawsSwitch: true,
      },
      {
        name: "attempt_not_latest with no detail leaves nothing",
        response: { outcome: "attempt_not_latest", detail: null },
        cardDrawsSwitch: false,
      },
      {
        name: "rung_target_unavailable with no detail leaves the Switch",
        response: { outcome: "rung_target_unavailable", detail: null },
        cardDrawsSwitch: true,
      },
      {
        name: "a kind this build does not know keeps every action",
        response: refusal("brand_new_kind", false),
        cardDrawsSwitch: true,
      },
    ];

    it.each(cases)(
      "$name, and the advisory shows exactly when the card has none",
      ({ response, cardDrawsSwitch }) => {
        seedSettledCard();
        render(<Scene turnIds={[TURN_ID]} />);
        expectHalves({ cardDrawsSwitch: true, advisory: "hidden" });

        harness.mutationResult = response;
        pressRetry();

        expectHalves({
          cardDrawsSwitch,
          advisory: cardDrawsSwitch ? "hidden" : "shown",
        });
      },
    );
  });

  it("a press still pending draws the Switch disabled and keeps the advisory hidden", () => {
    seedSettledCard();
    harness.deferResponses = true;
    render(<Scene turnIds={[TURN_ID]} />);
    pressRetry();

    expect(harness.pendingResponses).toHaveLength(1);
    const trigger = switchTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(true);
    expect(advisoryText()).toBe("hidden");
  });

  describe("while the stream is not open", () => {
    it("reconnecting draws the Switch disabled and keeps the advisory hidden", () => {
      seedSettledCard();
      harness.store.setState({ connectionStatus: "reconnecting" });
      render(<Scene turnIds={[TURN_ID]} />);

      const trigger = switchTrigger();
      expect(trigger).not.toBeNull();
      expect(trigger?.disabled).toBe(true);
      expect(advisoryText()).toBe("hidden");
    });

    it("an access the host has not stated yet draws the Switch disabled and keeps the advisory hidden", () => {
      seedSettledCard();
      harness.store.setState({ access: null });
      render(<Scene turnIds={[TURN_ID]} />);

      const trigger = switchTrigger();
      expect(trigger).not.toBeNull();
      expect(trigger?.disabled).toBe(true);
      expect(advisoryText()).toBe("hidden");
    });
  });

  it("a viewer sees no actions and the advisory shows", () => {
    seedSettledCard();
    harness.store.setState({
      access: { role: "viewer", ownerUserId: "owner-1", canAct: false },
    });
    render(<Scene turnIds={[TURN_ID]} />);

    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
  });

  describe("an attempt that admits no switch", () => {
    const withoutSwitch: ReadonlyArray<{
      readonly name: string;
      readonly rungs: ReadonlyArray<Rung>;
    }> = [
      { name: "retry only", rungs: ["retry"] },
      { name: "wait_once only", rungs: ["wait_once"] },
      { name: "retry and wait_once", rungs: ["retry", "wait_once"] },
    ];

    it.each(withoutSwitch)(
      "$name draws no Switch, so the advisory shows",
      ({ rungs }) => {
        harness.store.setState({
          lastFailedAttempt: attemptFor({
            turnId: TURN_ID,
            eligibleRungs: rungs,
            failedTuple: FAILED_CLAUDE_TUPLE,
          }),
          messages: [receiptMessage(TURN_ID)],
        });
        render(<Scene turnIds={[TURN_ID]} />);

        expect(screen.getByTestId("failed-turn-actions")).not.toBeNull();
        expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
      },
    );

    it("eligibleRungs [] draws nothing, so the advisory shows", () => {
      harness.store.setState({
        lastFailedAttempt: attemptFor({
          turnId: TURN_ID,
          eligibleRungs: [],
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
        messages: [receiptMessage(TURN_ID)],
      });
      render(<Scene turnIds={[TURN_ID]} />);

      expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
      expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
    });
  });

  it("with no seed to switch from (no failed tuple, no persisted settings) the card draws no Switch, so the advisory shows", () => {
    harness.store.setState({
      lastFailedAttempt: attemptFor({
        turnId: TURN_ID,
        eligibleRungs: ALL_RUNGS,
        failedTuple: null,
      }),
      chat: null,
      messages: [receiptMessage(TURN_ID)],
    });
    render(<Scene turnIds={[TURN_ID]} />);

    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
  });

  it("an older host that names no lastFailedAttempt draws no card, so the advisory shows", () => {
    harness.store.setState({
      lastFailedAttempt: undefined,
      messages: [receiptMessage(TURN_ID)],
    });
    render(<Scene turnIds={[TURN_ID]} />);

    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });
  });

  it("the refusal ends with its attempt: a new attempt on T2 draws the Switch again and hides the advisory", () => {
    seedSettledCard();
    const view = render(<Scene turnIds={[TURN_ID]} />);
    harness.mutationResult = refusal("message_changed", false);
    pressRetry();
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    // Mid-refusal: the card has no Switch, so the advisory is back.
    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });

    // The host names a new attempt on the replacement turn; its row is a
    // different transcript row, and the receipt is on its turn.
    act(() => {
      harness.store.setState({
        lastFailedAttempt: attemptFor({
          turnId: NEXT_TURN_ID,
          eligibleRungs: ALL_RUNGS,
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
        messages: [receiptMessage(TURN_ID), receiptMessage(NEXT_TURN_ID)],
      });
    });
    view.rerender(<Scene turnIds={[TURN_ID, NEXT_TURN_ID]} />);

    expectHalves({ cardDrawsSwitch: true, advisory: "hidden" });
  });

  it("a returning attempt never reappears under a stale refusal: after a countdown the same attempt draws its Switch again", () => {
    seedSettledCard();
    render(<Scene turnIds={[TURN_ID]} />);
    harness.mutationResult = refusal("message_changed", false);
    pressRetry();
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expectHalves({ cardDrawsSwitch: false, advisory: "shown" });

    // A visible countdown stands the row down (it unmounts), then the traversal
    // ends and the SAME attempt is named again.
    act(() => {
      harness.store.setState({
        pendingFallback: pendingFallback({
          state: "hold",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: TARGET_CODEX_TUPLE,
          impendingAction: null,
          deadline: 1_700_000_012_000,
          attempt: 1,
          maxAttempts: 3,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
          traversalId: "traversal-1",
          revision: 1,
        }),
      });
    });
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    act(() => {
      harness.store.setState({ pendingFallback: undefined });
    });

    expectHalves({ cardDrawsSwitch: true, advisory: "hidden" });
  });

  it("an answer landing after the card left is not recorded", () => {
    seedSettledCard();
    harness.deferResponses = true;
    render(<Scene turnIds={[TURN_ID]} />);
    pressRetry();
    expect(harness.pendingResponses).toHaveLength(1);

    // A visible countdown stands the row down (it unmounts) while the press
    // is still unanswered.
    act(() => {
      harness.store.setState({
        pendingFallback: pendingFallback({
          state: "hold",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: TARGET_CODEX_TUPLE,
          impendingAction: null,
          deadline: 1_700_000_012_000,
          attempt: 1,
          maxAttempts: 3,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
          traversalId: "traversal-1",
          revision: 1,
        }),
      });
    });
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();

    // The host answers late. The harness's mock calls the per-call handler even
    // after unmount, which real TanStack does not; the card's own guard makes
    // that divergence irrelevant.
    act(() => {
      harness.pendingResponses[0](refusal("message_changed", false));
    });
    act(() => {
      harness.store.setState({ pendingFallback: undefined });
    });

    expectHalves({ cardDrawsSwitch: true, advisory: "hidden" });
  });
});

/** One tile's own view: every query scoped to its container. */
interface Tile {
  readonly view: RenderResult;
  readonly hasSwitch: () => boolean;
  readonly advisory: () => string | null;
  readonly pressRetry: () => void;
  readonly hasActions: () => boolean;
  readonly note: () => string | null;
}

function tileOf(view: RenderResult): Tile {
  const scope = within(view.container);
  return {
    view,
    hasSwitch: (): boolean =>
      scope.queryByRole("button", { name: "Switch to…" }) !== null,
    advisory: (): string | null => scope.getByTestId("advisory").textContent,
    pressRetry: (): void => {
      fireEvent.click(scope.getByRole("button", { name: "Retry" }));
    },
    hasActions: (): boolean =>
      scope.queryByTestId("failed-turn-actions") !== null,
    note: (): string | null => {
      const note = scope.queryByTestId("failed-turn-refusal");
      return note === null ? null : note.textContent;
    },
  };
}

describe("two cards for one turn (two tiles of one chat)", () => {
  function openTwoTiles() {
    seedSettledCard();
    const a = tileOf(render(<Scene turnIds={[TURN_ID]} />));
    const b = tileOf(render(<Scene turnIds={[TURN_ID]} />));
    for (const tile of [a, b]) {
      expect(tile.hasSwitch()).toBe(true);
      expect(tile.advisory()).toBe("hidden");
    }
    return { a, b };
  }

  function expectRefused(tile: Tile): void {
    expect(tile.hasSwitch()).toBe(false);
    expect(tile.hasActions()).toBe(false);
    expect(tile.advisory()).toBe("shown");
  }

  it("closing the OTHER tile keeps the survivor's refusal", () => {
    const { a, b } = openTwoTiles();
    harness.mutationResult = refusal("message_changed", false);
    a.pressRetry();
    expectRefused(a);
    expectRefused(b);

    b.view.unmount();

    expectRefused(a);
  });

  it("closing the PRESSING tile keeps the survivor's refusal", () => {
    const { a, b } = openTwoTiles();
    harness.mutationResult = refusal("message_changed", false);
    a.pressRetry();
    expectRefused(b);

    a.view.unmount();

    expectRefused(b);
  });

  it("the last tile leaving releases the refusal, and a reopened card starts clean", () => {
    const { a, b } = openTwoTiles();
    harness.mutationResult = refusal("message_changed", false);
    a.pressRetry();
    a.view.unmount();
    b.view.unmount();

    const fresh = tileOf(render(<Scene turnIds={[TURN_ID]} />));

    expect(fresh.hasSwitch()).toBe(true);
    expect(fresh.advisory()).toBe("hidden");
  });

  it("an answer landing after ONE of two tiles left is recorded for the survivor", () => {
    const { a, b } = openTwoTiles();
    harness.deferResponses = true;
    a.pressRetry();
    expect(harness.pendingResponses).toHaveLength(1);
    a.view.unmount();

    act(() => {
      harness.pendingResponses[0](refusal("message_changed", false));
    });

    expectRefused(b);
    // The survivor's card answers it, so the announcer stays quiet.
    expect(b.note()).not.toBe("");
    expect(b.note()).not.toBeNull();
    expect(harness.publishedUnattended).toEqual([]);
  });

  it("an answer landing after the LAST tile left is not recorded, and the announcer speaks it", () => {
    const { a, b } = openTwoTiles();
    harness.deferResponses = true;
    a.pressRetry();
    expect(harness.pendingResponses).toHaveLength(1);
    a.view.unmount();
    b.view.unmount();

    act(() => {
      harness.pendingResponses[0](refusal("message_changed", false));
    });

    expect(harness.publishedUnattended).toEqual([
      {
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        text: "The original message changed, so it can't be replayed. Send it again from the composer.",
      },
    ]);
    const fresh = tileOf(render(<Scene turnIds={[TURN_ID]} />));
    expect(fresh.hasSwitch()).toBe(true);
    expect(fresh.advisory()).toBe("hidden");
  });
});
