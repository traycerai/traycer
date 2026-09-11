import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  FallbackWaitDisposition,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFallbackListTargetsResponse } from "@traycer/protocol/host/chat-fallback";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FallbackManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import { formatClockTime } from "@/lib/relative-time";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  fallbackModelTarget,
  lastFailedAttempt,
  listTargetsResponse,
} from "./fallback-fixtures";

const EPIC_ID = "epic-manual";
const CHAT_ID = "chat-manual";
const HOST_ID = "host-manual";
const TURN_ID = "turn-attempt";
const USER_MESSAGE_ID = "user-msg-attempt";
const RESETS_AT = new Date(2026, 5, 15, 15, 0, 0).getTime();

/**
 * Cold-review re-review: the `rung_unavailable` cases used to compute this
 * from `describeFallbackOutcome("rung_unavailable")` and assert against that
 * same call - a test that derives its expectation from the code under test
 * cannot reject a change to that code (restoring the withdrawn "this chat has
 * moved on" copy would still satisfy such an assertion). Written out
 * literally instead.
 */
const RUNG_UNAVAILABLE_LABEL = "That action isn't available right now.";

const harness = vi.hoisted(() => {
  // The published confirmed actions, in order. The announcer reads this slot
  // for real; here it is a recorder so a case can assert what was published.
  const publishedActions: unknown[] = [];
  // Same idea for MF11's unattended-outcome channel: `useFallbackRunManualRung`
  // reaches `publishUnattended` through the reporting object built from this
  // slice's own `usePublishUnattendedFallbackOutcome`, which in turn resolves
  // through `useExistingChatSessionHandle` -> `handle.store.getState()`. A
  // slice omitting this member fails the same way the comment below warns
  // about for `publishConfirmedManualFallbackAction`: a production stack trace
  // inside `use-unattended-fallback-outcome.ts` wearing a fixture gap.
  const publishedUnattended: unknown[] = [];
  // `publishConfirmedManualFallbackAction` is part of the slice, not an extra
  // on the double: the component reaches it through
  // `handle.store.getState()`, so a slice that omits it fails as
  // "publishConfirmedManualFallbackAction is not a function" thrown INSIDE
  // `use-confirmed-manual-action.ts` - a fixture gap wearing a production
  // stack trace, which is the same class as the under-modelled `onSuccess`
  // below.
  //
  // `access` and `connectionStatus` are the chat's ACT CAPABILITY, and they
  // are part of the slice for the same reason the two publishers are: the
  // component reaches them through `handle.store`, so a slice that omitted
  // them would answer `undefined` and silently disable every affordance in
  // this file - a fixture gap that reads as "the feature is broken" rather
  // than "the double is short". The default is the state every case here
  // assumed before the gate existed: this user owns the chat and its stream is
  // up. The two cases where it is not are pinned explicitly below.
  type Slice = {
    lastFailedAttempt: LastFailedAttempt | undefined;
    access: { readonly canAct: boolean } | null;
    connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
    publishConfirmedManualFallbackAction: (input: unknown) => void;
    publishUnattendedFallbackOutcome: (input: unknown) => void;
  };
  const initialSlice = (): Slice => ({
    lastFailedAttempt: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    publishConfirmedManualFallbackAction: (input: unknown): void => {
      publishedActions.push(input);
    },
    publishUnattendedFallbackOutcome: (input: unknown): void => {
      publishedUnattended.push(input);
    },
  });
  let state: Slice = initialSlice();
  const listeners = new Set<() => void>();
  const store = {
    getState: (): Slice => state,
    getInitialState: (): Slice => initialSlice(),
    // MERGES, because zustand's `setState` merges shallowly and the call sites
    // here pass only `{ lastFailedAttempt }`. A replacing double would drop
    // the action above on the first `setState` and reintroduce exactly the
    // failure this slice was widened to fix - silently, one call later.
    setState: (next: Partial<Slice>): Slice => {
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
    mutate: vi.fn(),
    openSettings: vi.fn(),
    toast: vi.fn(),
    store,
    publishedActions,
    publishedUnattended,
    listCalls: [] as Array<{
      readonly enabled: boolean;
      readonly selector: unknown;
    }>,
    listData: undefined as ChatFallbackListTargetsResponse | undefined,
    mutationResult: null as { readonly outcome: string } | null,
    // Deferred mode, for the ONE thing a synchronous double cannot express:
    // the ORDER of the newer-turn frame and the host's answer. Every other case
    // here resolves inside `mutate`, which fixes that order to "answer first"
    // and therefore cannot reach MF11's failing sequence at all.
    deferResponses: false,
    pendingResponses: [] as Array<
      (result: { readonly outcome: string }) => void
    >,
  };
});

vi.mock("sonner", () => ({
  toast: harness.toast,
}));

vi.mock("@/components/chat/fallback/use-fallback-targets", () => ({
  useFallbackListTargets: (
    _client: unknown,
    input: { readonly enabled: boolean; readonly selector: unknown },
  ) => {
    harness.listCalls.push({
      enabled: input.enabled,
      selector: input.selector,
    });
    return {
      data: harness.listData,
      isPending: false,
      isError: false,
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => ({ store: harness.store }),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: EPIC_ID }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    args: {
      readonly onSuccess:
        | ((response: { readonly outcome: string }, variables: unknown) => void)
        | undefined;
    },
  ) => ({
    mutate: (
      vars: unknown,
      opts:
        | {
            readonly onSuccess:
              | ((
                  response: { readonly outcome: string },
                  variables: unknown,
                ) => void)
              | undefined;
          }
        | undefined,
    ) => {
      harness.mutate(vars);
      // TanStack runs the hook-level onSuccess in addition to the per-call
      // one. The Switch-vs-toast pin depends on both firing.
      //
      // BOTH receive `vars` as the second argument, because that is TanStack's
      // real signature - `onSuccess(data, variables, context)` - and the
      // hook-level handler reads it: the confirmed-action record is built from
      // `variables.rung` / `.userMessageId` / `.turnId` / `.target`, which the
      // response does not carry. Passing only `result` here modelled the
      // callback too narrowly, and the omission was invisible for as long as
      // nothing read the second parameter; the moment the record landed it
      // surfaced as `TypeError: Cannot read properties of undefined (reading
      // 'rung')` thrown INSIDE `use-fallback-actions.ts`, which reads as a
      // production bug rather than a fixture gap. Model the full signature even
      // where a parameter is currently unread.
      const deliver = (result: { readonly outcome: string }): void => {
        if (args.onSuccess !== undefined) {
          args.onSuccess(result, vars);
        }
        // Deliberately delivered even when the initiating subtree has since
        // unmounted, where real TanStack would SKIP this one. The double is
        // conservative in the safe direction: if the per-call handler ever
        // became a second reporting channel, a duplicate-publication pin would
        // catch it here rather than be hidden by a faithful skip.
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
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: harness.openSettings }),
}));

function positiveAttempt(input: {
  readonly userMessageId: string;
  readonly turnId: string;
  readonly reason: "rate_limit" | "auth";
  readonly eligibleRungs: ReadonlyArray<"retry" | "switch" | "wait_once">;
  readonly resetsAt: number | undefined;
  readonly waitDisposition: FallbackWaitDisposition;
}): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: input.userMessageId,
    turnId: input.turnId,
    failure:
      input.resetsAt === undefined
        ? { reason: input.reason }
        : {
            reason: input.reason,
            resetsAt: input.resetsAt,
            resetsAtSource: "provider",
          },
    eligibleRungs: input.eligibleRungs,
    waitDisposition: input.waitDisposition,
    // Derived, and ONLY across the two values that explain nothing.
    //
    // Every call site of this helper predates the switch verdict and none of
    // them is about it, so the two "there is a button, or there is no claim"
    // values keep their rendered output exactly what those assertions were
    // written against. `no_destination` - the value under test, and the only
    // one that renders a sentence - is never produced here: a test that wants
    // it uses {@link withheldSwitchAttempt} and says so. A fixture that could
    // derive the value under test would pass with the rule deleted.
    switchDisposition: input.eligibleRungs.includes("switch")
      ? "eligible"
      : "unknown",
    failedTuple: FAILED_CLAUDE_TUPLE,
  });
}

/**
 * The attempt shape this lane is about: a chat the host found no destination
 * for, so `switch` is absent from `eligibleRungs` AND the disposition says why.
 *
 * Separate from {@link positiveAttempt} rather than a parameter on it, so the
 * pairing of those two facts is written out at the one place it is asserted
 * instead of computed by a builder the assertions would then be testing.
 */
function withheldSwitchAttempt(
  failedTuple: ChatRunSettings | null,
): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: USER_MESSAGE_ID,
    turnId: TURN_ID,
    failure: { reason: "rate_limit" },
    // `retry` stays. The point of the row is that ONE control went away and
    // the others did not - a bare card would be explained by any number of
    // rules, and would pass with the switch gate deleted and the whole DTO
    // withheld instead.
    eligibleRungs: ["retry"],
    waitDisposition: "no_verified_reset",
    switchDisposition: "no_destination",
    failedTuple,
  });
}

/**
 * A Default-shaped Claude chat: the exact tuple the defect is about.
 *
 * `default` is a real slug the Claude SDK advertises, and its model family
 * lives only in the catalog LABEL (`Default (Sonnet 4.5)`) - which is why it
 * belongs to no equivalence class the host matches on a slug, and why a chat
 * on it has nowhere to switch.
 */
const DEFAULT_SHAPED_TUPLE: ChatRunSettings = chatRunSettings({
  harnessId: "claude",
  model: "default",
  profileId: null,
});

const ALL_RUNGS: ReadonlyArray<"retry" | "switch" | "wait_once"> = [
  "retry",
  "switch",
  "wait_once",
];

function seedAttempt(attempt: LastFailedAttempt | undefined): void {
  harness.store.setState({ lastFailedAttempt: attempt });
}

/**
 * The chat's act capability, exactly as the session store publishes it -
 * `access.canAct` for the role, `connectionStatus` for the stream.
 *
 * Both, and separately, because the component ANDs them and a single flag
 * could not tell the two refusals apart: a viewer is refused permanently, an
 * owner mid-reconnect is refused for a moment. A pin that only ever moved one
 * of them would leave the other term free to be deleted.
 */
function seedActCapability(input: {
  readonly canAct: boolean;
  readonly connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
}): void {
  harness.store.setState({
    access: { canAct: input.canAct },
    connectionStatus: input.connectionStatus,
  });
}

/** Narrows a queried control to the element whose `disabled` is the answer. */
function buttonNamed(name: string): HTMLButtonElement {
  const element = screen.getByRole("button", { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`expected "${name}" to be a button`);
  }
  return element;
}

function renderActions(turnId: string) {
  return render(
    <TabHostProvider hostId={HOST_ID}>
      <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
        <FallbackManualRungActions turnId={turnId} />
      </ChatTranscriptProvider>
    </TabHostProvider>,
  );
}

describe("FallbackManualRungActions", () => {
  beforeEach(() => {
    harness.mutate.mockReset();
    harness.openSettings.mockReset();
    harness.toast.mockReset();
    harness.listCalls = [];
    harness.listData = undefined;
    harness.mutationResult = null;
    // In place, not reassigned: the recorder closure captured this array when
    // the slice was built, so a fresh array here would be written to by
    // nothing and every later assertion would read an empty list.
    harness.publishedActions.length = 0;
    harness.publishedUnattended.length = 0;
    harness.deferResponses = false;
    harness.pendingResponses.length = 0;
    // Restored per test, not merely seeded once: `setState` MERGES, so a case
    // that drops the capability would otherwise leave every later case running
    // as a viewer - and they would fail as "the button isn't there", which is
    // the wrong diagnosis entirely.
    seedActCapability({ canAct: true, connectionStatus: "open" });
    seedAttempt(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Retry, Switch…, and Wait until for a fully eligible rate-limit attempt", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Switch…" })).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    ).toBeDefined();
    const root = screen.getByRole("button", { name: "Retry" }).parentElement;
    const text = root?.textContent ?? "";
    expect(text).not.toMatch(BANNED_VOCABULARY);
    expect(text).not.toContain("rate_limit");
  });

  // The negative twins of the case above, and the reason this card needed a
  // gate at all: `ErrorSegment` is DURABLE TRANSCRIPT, so these affordances
  // mount for anyone who can open the chat, and `chat.fallback.runManualRung`
  // is a plain unary RPC with nothing client-side in front of it. Before the
  // `useChatFallbackActionsCanAct` gate, `busy` was `runManualRung.isPending`
  // and nothing else, so both rows below rendered ENABLED buttons that really
  // dispatched.
  //
  // Same fixture as the fully-eligible case above - the attempt, the rungs and
  // the disposition are identical, and only the capability moves. That is what
  // makes these two a control pair rather than two spot checks: neither can
  // pass because the buttons happened not to render.
  it("disables every affordance for a VIEWER, and dispatches nothing", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    // The stream is UP. This row is about the role alone, so a gate that only
    // read `connectionStatus` would leave it red.
    seedActCapability({ canAct: false, connectionStatus: "open" });
    renderActions(TURN_ID);

    const retry = buttonNamed("Retry");
    // Falsification: drop the `|| !canAct` term from `busy` and all three of
    // these go red, because the buttons are still RENDERED either way - the
    // host said this failure admits all three rungs, and that is unchanged by
    // who is looking at it.
    expect(retry.disabled).toBe(true);
    expect(buttonNamed("Switch…").disabled).toBe(true);
    expect(
      buttonNamed(`Wait until ${formatClockTime(RESETS_AT)}`).disabled,
    ).toBe(true);

    fireEvent.click(retry);
    // The assertion that makes the three above mean something: a disabled
    // button is only a claim about the DOM, this is the claim about the wire.
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  it("disables every affordance for an OWNER whose chat stream has dropped", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    // The role is fine; the transport is not. `canSendAction` refuses the
    // stream-side hold in exactly this state, and this card now agrees with
    // it. Falsification: drop the `connectionStatus === "open"` term from
    // `useChatFallbackActionsCanAct` and this cell goes red while the viewer
    // cell above stays green.
    seedActCapability({ canAct: true, connectionStatus: "reconnecting" });
    renderActions(TURN_ID);

    const retry = buttonNamed("Retry");
    expect(retry.disabled).toBe(true);
    expect(buttonNamed("Switch…").disabled).toBe(true);

    fireEvent.click(retry);
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  // F10: this card always calls `switchConsequencesText(null)` - a failed
  // ATTEMPT carries no queue figure - and nothing pinned that the menu it
  // opens actually says so, as opposed to staying silent about the queue or
  // (the waiting-menu bug this batch is fixing elsewhere) reading a stale
  // zero as "nothing queued".
  it("states the switch consequences, with the no-queue-figure phrasing, in the Switch… menu header", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    // Falsification: change `switchConsequencesText(null)` to
    // `switchConsequencesText(0)` at this card's call site - both compile,
    // but `0` takes the "queue not mentioned" branch instead of the "no
    // figure exists" one, and this exact sentence goes red.
    expect(
      screen.getByText(
        "Replays this message on the destination you pick. Starts a fresh session from this transcript. Any queued messages move with it.",
      ),
    ).toBeDefined();
  });

  // F6: `describeWaitDisposition`'s sentence is shared by the card (`Body`'s
  // full-width line) AND the Switch… menu's empty state - one source, two
  // renderers - and nothing pinned either half. `attempt_unavailable`'s
  // sentence was also rewritten (D220): the withdrawn wording claimed the
  // message "can't be re-sent on the account it ran on", which the host never
  // told us; the fixed sentence says only that waiting is not on offer.
  it("states the wait disposition on the card, and repeats it inside the empty Switch… menu", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        // No "wait_once": the disposition explains its own absence, and no
        // "retry" either, to keep this fixture minimal - only "switch" is
        // needed to reach the menu's empty-state branch below.
        eligibleRungs: ["switch"],
        resetsAt: undefined,
        waitDisposition: "attempt_unavailable",
      }),
    );
    // Empty listing, so the menu's own empty-state branch (which carries
    // `emptyStateActions`, and therefore this sentence) is what renders.
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [],
      modelTargetsSkip: null,
    });
    renderActions(TURN_ID);
    // Falsification: revert `attempt_unavailable`'s copy to the withdrawn
    // sentence ("This message can't be re-sent on the account it ran on.")
    // and both assertions below go red - they are pinned to the FIXED wording.
    expect(
      screen.getByText("Waiting isn't available for this message."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    // Falsification (the other half): delete the `waitExplanation` block from
    // `emptyStateActions` in `fallback-manual-rungs.tsx` - the card-level
    // sentence above stays green and this one alone goes red, which is the
    // whole reason F6 needs its own menu-side pin rather than trusting the
    // card's copy to cover both renderers.
    expect(
      screen.getAllByText("Waiting isn't available for this message."),
    ).toHaveLength(2);
  });

  // Cold-review re-review, F6 gap 1: `checking` and `beyond_cap` had NO render
  // fixture anywhere - only `no_verified_reset` and `attempt_unavailable` were
  // ever seeded. Two literal sentences, neither derived from
  // `describeWaitDisposition`.
  it("renders the checking sentence while a reset probe is in flight", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: undefined,
        waitDisposition: "checking",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: change the `checking` arm of `describeWaitDisposition`
    // to any other wording - this literal goes red.
    expect(
      screen.getByText(
        "Checking whether this account has a confirmed reset time.",
      ),
    ).toBeDefined();
  });

  it("renders the beyond-cap sentence, with and without a named reset time", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: undefined,
        waitDisposition: "beyond_cap",
      }),
    );
    const { unmount } = renderActions(TURN_ID);
    // Falsification: swap the `resetsAtLabel === null` branches in
    // `describeWaitDisposition`'s `beyond_cap` arm - this goes red for a
    // failure with no verified reset time in hand.
    expect(
      screen.getByText(
        "This limit resets later than your longest wait allows.",
      ),
    ).toBeDefined();
    unmount();

    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: RESETS_AT,
        waitDisposition: "beyond_cap",
      }),
    );
    renderActions(TURN_ID);
    expect(
      screen.getByText(
        `This limit resets at ${formatClockTime(RESETS_AT)}, later than your longest wait allows.`,
      ),
    ).toBeDefined();
  });

  // Cold-review re-review, F6 gap 2: the no-reset sentence had a fixture
  // (`no_verified_reset` is used elsewhere in this file to keep the Wait
  // button off) but no assertion on its actual TEXT anywhere.
  it("renders the no-confirmed-reset sentence independently of the Wait button's absence", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: undefined,
        waitDisposition: "no_verified_reset",
      }),
    );
    renderActions(TURN_ID);
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
    // Falsification: change `no_verified_reset`'s copy to any other wording -
    // this literal goes red independently of the button-absence check above.
    expect(
      screen.getByText(
        "No confirmed reset time for this account yet, so there's nothing to wait for.",
      ),
    ).toBeDefined();
  });

  // Cold-review re-review, F6 gap 3: every `attempt_unavailable` case so far
  // deliberately excluded Retry. The contract the sentence has to keep is
  // that it stays TRUTHFUL while Retry is still on offer - this is the
  // control that would have caught the withdrawn copy claiming something
  // about the account the message ran on, since that claim would have read
  // as false beside a live, clickable Retry button.
  it("keeps Retry enabled and clickable beside the attempt-unavailable sentence", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: undefined,
        waitDisposition: "attempt_unavailable",
      }),
    );
    renderActions(TURN_ID);
    expect(
      screen.getByText("Waiting isn't available for this message."),
    ).toBeDefined();
    const retry = screen.getByRole("button", { name: "Retry" });
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error("expected the Retry button");
    }
    // Falsification: this is the control the withdrawn copy would have
    // failed - "can't be re-sent on the account it ran on" beside an ENABLED
    // Retry button is a contradiction the sentence must not make.
    expect(retry.disabled).toBe(false);
  });

  it("renders no action buttons and does render the settings link when eligibleRungs is empty", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: [],
        resetsAt: RESETS_AT,
        waitDisposition: "no_verified_reset",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: drop the rungs.includes(...) guards and render the buttons unconditionally — this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fallback settings" }),
    ).toBeDefined();
  });

  // F12: the companion case to the one above. The Settings link is not the
  // consolation prize for an empty state - the ticket's own wording is that
  // it "stays reachable" on an ACTIONABLE card too, alongside Retry/Switch…/
  // Wait until, not only in their absence.
  it("renders the settings link alongside the action buttons when rungs are available", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    // Falsification: wrap `<FallbackNoticeSettingsLink />` at :331 in the
    // condition it used to be guarded by - render it only when no rung
    // buttons exist - and this assertion goes red while the all-disabled
    // menu case (F12's other half, `fallback-destination-menu.test.tsx`)
    // stays green: that split is what distinguishes "the link exists
    // somewhere" from "the link exists where the user has other options".
    expect(
      screen.getByRole("button", { name: "Fallback settings" }),
    ).toBeDefined();
  });

  it("renders nothing when lastFailedAttempt is undefined", () => {
    seedAttempt(undefined);
    renderActions(TURN_ID);
    // Falsification: delete the if (attempt === undefined) return null line — this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fallback settings" }),
    ).toBeNull();
  });

  it("renders nothing on a row whose turnId does not match the attempt, and clears by value", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: "turn-a",
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions("turn-b");
    // Falsification: remove the attempt.turnId !== turnId guard — this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    cleanup();
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    act(() => {
      harness.store.setState({ lastFailedAttempt: undefined });
    });
    // Falsification: make the hook remember its last non-undefined value — this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders no rungs for an auth failure even when every rung is eligible", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "auth",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: delete the auth guard — Retry appears and this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
  });

  it("gates the wait button on wait_once eligibility, never on resetsAt alone", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    const { unmount } = renderActions(TURN_ID);
    expect(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    ).toBeDefined();
    unmount();

    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: undefined,
        waitDisposition: "eligible",
      }),
    );
    const second = renderActions(TURN_ID);
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    second.unmount();

    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry", "switch"],
        resetsAt: RESETS_AT,
        waitDisposition: "no_verified_reset",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: change waitUntilLabel to gate on resetsAt alone — this assertion must go red.
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("sends the attempt's ids, not the row's, on Retry and Wait until", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Falsification: hard-code userMessageId: "" at the call site — this assertion must go red.
    expect(harness.mutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "retry",
      target: null,
      userMessageId: USER_MESSAGE_ID,
      turnId: TURN_ID,
    });

    harness.mutate.mockReset();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    );
    expect(harness.mutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "wait_once",
      target: null,
      userMessageId: USER_MESSAGE_ID,
      turnId: TURN_ID,
    });
  });

  it("lists destinations with the attempt selector and sends runManualRung switch with both ids", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        fallbackModelTarget({
          groupId: "grp-internal-secret-xyz",
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: "gpt-5",
          reasoningEffort: null,
          profileId: TARGET_CODEX_TUPLE.profileId,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          warnings: [],
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    const issued = harness.listCalls.filter((call) => call.enabled);
    expect(
      issued.length,
      "listTargets must run after the menu opened",
    ).toBeGreaterThan(0);
    const lastIssued = issued[issued.length - 1];
    expect(lastIssued.selector).toEqual({
      kind: "attempt",
      userMessageId: USER_MESSAGE_ID,
      turnId: TURN_ID,
    });
    fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    expect(
      harness.mutate.mock.calls.length,
      "runManualRung must be called",
    ).toBeGreaterThan(0);
    const first = harness.mutate.mock.calls[0];
    expect(first[0]).toEqual({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "switch",
      target: TARGET_CODEX_TUPLE,
      userMessageId: USER_MESSAGE_ID,
      turnId: TURN_ID,
    });
  });

  it("reports a Switch refusal inline and does not toast", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        fallbackModelTarget({
          groupId: "grp-internal-secret-xyz",
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: "gpt-5",
          reasoningEffort: null,
          profileId: TARGET_CODEX_TUPLE.profileId,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          warnings: [],
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.getByText(RUNG_UNAVAILABLE_LABEL)).toBeDefined();
    expect(screen.getByRole("button", { name: /Codex · gpt-5/ })).toBeDefined();
    // Falsification: restore onSuccess: toastFallbackOutcome on the useFallbackRunManualRung hook and this assertion must go red.
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("a refused switch picked while the menu is OPEN reports inline only - no toast, and no unattended publication (no duplicate channel)", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        fallbackModelTarget({
          groupId: "grp-internal-secret-xyz",
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: "gpt-5",
          reasoningEffort: null,
          profileId: TARGET_CODEX_TUPLE.profileId,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          warnings: [],
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.getByText(RUNG_UNAVAILABLE_LABEL)).toBeDefined();
    expect(harness.toast).not.toHaveBeenCalled();
    // Falsification: drop the `reportingRef.current.inlineMenuOpen` early
    // return in `useFallbackRunManualRung`'s hook-level onSuccess (so the
    // hook always publishes to the announcer regardless of the open menu) and
    // THIS assertion must go red - the refusal would be reported twice, once
    // inline and once through the announcer.
    expect(harness.publishedUnattended).toEqual([]);
  });

  /**
   * The P1 case, and the falsifier the `runManualRung` widening was missing.
   *
   * Every other switch case here resolves the mutation INSIDE `mutate`, which
   * fixes the order to "host answers, then the frame lands" - the order in
   * which nothing is wrong. `attempt_not_latest` means the opposite order: a
   * newer turn already exists, so the frame that carries it arrives FIRST and
   * takes the menu with it. That is the sequence this case drives, and until
   * the affordances became their own component it delivered the refusal to
   * nobody: the gate returned `null` while `ManualRungAffordances`' predecessor
   * stayed MOUNTED, so `menuOpen` was still `true`, the per-render layout effect
   * kept republishing `inlineMenuOpen: true` from a subtree rendering nothing,
   * and the hook deferred to an inline line that no longer existed.
   */
  it("a switch refused AFTER a newer turn replaces the attempt reaches the announcer - the surface it was picked from is gone", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        fallbackModelTarget({
          groupId: "grp-internal-secret-xyz",
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: "gpt-5",
          reasoningEffort: null,
          profileId: TARGET_CODEX_TUPLE.profileId,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          warnings: [],
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    harness.deferResponses = true;
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(harness.pendingResponses).toHaveLength(1);

    // The newer turn lands while the pick is still in flight. This is the real
    // production transition - the host reassigns `lastFailedAttempt` by value -
    // not a test-driven unmount of the component under test.
    act(() => {
      seedAttempt(
        positiveAttempt({
          userMessageId: "user-msg-later",
          turnId: "turn-later",
          reason: "rate_limit",
          eligibleRungs: ALL_RUNGS,
          resetsAt: RESETS_AT,
          waitDisposition: "eligible",
        }),
      );
    });
    // The whole surface the pick came from is gone: no trigger, no rows, and
    // no inline refusal line to write into.
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Codex · gpt-5/ })).toBeNull();

    // ONLY NOW does the host answer.
    act(() => {
      harness.pendingResponses[0]({ outcome: "attempt_not_latest" });
    });

    // Written literally, like `RUNG_UNAVAILABLE_LABEL` above and for the same
    // reason - `CHAT_MOVED_ON_LABEL` is module-private to `fallback-copy.ts`.
    //
    // Falsification: move `menuOpen`/`refusal`/`useFallbackRunManualRung` back
    // up into `ManualRungActions` (i.e. undo the split, so the gate becomes an
    // early `return null` inside the mounted component again) and THIS must go
    // red at zero entries - the hook reads a stale `inlineMenuOpen: true` and
    // defers to an inline line that is not rendering.
    expect(harness.publishedUnattended).toHaveLength(1);
    expect(harness.publishedUnattended[0]).toMatchObject({
      chatId: CHAT_ID,
      epicId: EPIC_ID,
      hostId: HOST_ID,
      text: "This chat has moved on since that message.",
    });
    // One channel, not two: a bare rung would have toasted, a live menu would
    // have answered inline. This surface has neither.
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("closes the Switch menu on applied and still does not toast", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.listData = listTargetsResponse({
      outcome: "listed",
      failedTuple: FAILED_CLAUDE_TUPLE,
      profileTargets: [],
      modelTargets: [
        fallbackModelTarget({
          groupId: "grp-internal-secret-xyz",
          harnessId: "codex",
          modelFamily: "gpt-5",
          model: "gpt-5",
          reasoningEffort: null,
          profileId: TARGET_CODEX_TUPLE.profileId,
          severity: "ok",
          usedPercent: 10,
          target: TARGET_CODEX_TUPLE,
          warnings: [],
          selectable: true,
          skip: null,
        }),
      ],
      modelTargetsSkip: null,
    });
    harness.mutationResult = { outcome: "applied" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.queryByRole("button", { name: /Codex · gpt-5/ })).toBeNull();
    expect(
      screen.queryByText(
        "That isn't available any more — this chat has moved on.",
      ),
    ).toBeNull();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("toasts a Retry refusal with the literal rung_unavailable copy", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Falsification: delete the `toast(message)` line from the
    // `variables.rung !== "switch"` branch of `useFallbackRunManualRung`'s
    // hook-level onSuccess (use-fallback-actions.ts) and this must go red.
    //
    // The falsifier this comment used to name - "drop the per-call onSuccess
    // from the run() call site" - no longer exists: MF11 moved a bare rung's
    // refusal off the per-call handler, which TanStack skips once the row's
    // observer is gone, onto the hook-level one that outlives it. `run()`'s
    // `mutate()` now passes no options object at all.
    expect(harness.toast).toHaveBeenCalledWith(RUNG_UNAVAILABLE_LABEL);
  });

  it("a refused Retry (bare button) toasts once with the literal refusal sentence and publishes nothing to the announcer", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.toast).toHaveBeenCalledWith(RUNG_UNAVAILABLE_LABEL);
    // Falsification: route the `rung !== "switch"` branch in
    // `useFallbackRunManualRung`'s onSuccess through `publishUnattended`
    // instead of (or in addition to) `toast`, and THIS assertion must go red -
    // a bare rung's refusal has exactly one channel, the toast.
    expect(harness.publishedUnattended).toEqual([]);
  });

  it("toasts a Wait-until refusal too", () => {
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: RESETS_AT,
        waitDisposition: "eligible",
      }),
    );
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    );
    expect(harness.toast).toHaveBeenCalledWith(RUNG_UNAVAILABLE_LABEL);
  });

  /**
   * The switch verdict: a control withheld must be a control EXPLAINED.
   *
   * The three cases are a matrix over one host field, not three spot checks,
   * and the middle one is the control that makes the other two mean something:
   * the same component, the same row, the same everything except
   * `switchDisposition`, so neither the presence nor the absence of the button
   * can be explained by anything else on the frame.
   *
   * Every assertion is on the RULE - "a chat with no destination offers no
   * switch and says why" - rather than on this quarter's wording, except the
   * one that has to be literal: the sentence must name the chat, and only a
   * substring check can prove a generic line did not creep back in.
   */
  describe("the switch verdict", () => {
    it("offers no Switch… and names the chat when the host found no destination", () => {
      seedAttempt(withheldSwitchAttempt(DEFAULT_SHAPED_TUPLE));
      renderActions(TURN_ID);

      expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
      // The row is not merely bare - `retry` survives. A card that lost every
      // control would satisfy the line above with the whole DTO withheld.
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

      const root = screen.getByRole("button", { name: "Retry" }).parentElement;
      const text = root?.textContent ?? "";
      // The chat's own identity, resolved the way every other fallback surface
      // resolves one: the PROVIDER DISPLAY NAME, never the harness id that the
      // host's own transcript copy uses. A sentence reading "claude/default"
      // would pass a looser check and be the wrong voice entirely.
      expect(text).toContain("Claude Code · default");
      expect(text).not.toContain("claude/default");
      // Engine words, "group" included - the reason this sentence could not be
      // the host's own `no-group` label.
      expect(text).not.toMatch(BANNED_VOCABULARY);
    });

    it("still offers Switch… when the host named a destination", () => {
      seedAttempt(
        positiveAttempt({
          userMessageId: USER_MESSAGE_ID,
          turnId: TURN_ID,
          reason: "rate_limit",
          eligibleRungs: ["retry", "switch"],
          resetsAt: undefined,
          waitDisposition: "no_verified_reset",
        }),
      );
      renderActions(TURN_ID);

      expect(screen.getByRole("button", { name: "Switch…" })).toBeDefined();
      const root = screen.getByRole("button", { name: "Retry" }).parentElement;
      // No explanation beside a working button. The sentence exists to explain
      // an ABSENCE, and one printed next to the control it describes would be
      // the card contradicting itself.
      expect(root?.textContent ?? "").not.toContain("No other model is set up");
    });

    it("offers Switch… and claims nothing when the host could not check", () => {
      // The unreadable-policy / never-recorded arm, and the one that would be
      // a lie in the other direction: telling a user their setup is empty when
      // the truth is we could not look. `unknown` OFFERS, and stays silent.
      //
      // Built literally rather than through `positiveAttempt`, whose derivation
      // cannot reach this pairing: a failed tuple IS in hand here - the envelope
      // survived and only the verdict is missing - so a sentence would have had
      // every ingredient it needed and must still not be printed.
      seedAttempt(
        lastFailedAttempt({
          userMessageId: USER_MESSAGE_ID,
          turnId: TURN_ID,
          failure: { reason: "rate_limit" },
          eligibleRungs: ["retry", "switch"],
          waitDisposition: "no_verified_reset",
          switchDisposition: "unknown",
          failedTuple: DEFAULT_SHAPED_TUPLE,
        }),
      );
      renderActions(TURN_ID);

      expect(screen.getByRole("button", { name: "Switch…" })).toBeDefined();
      const root = screen.getByRole("button", { name: "Retry" }).parentElement;
      expect(root?.textContent ?? "").not.toContain("No other model is set up");
    });

    it("says nothing rather than a subject-less sentence with no failed tuple", () => {
      // `failedTuple: null` travels with a missing replay envelope. There is
      // nothing to name, and "No other model is set up for" trailing into
      // nothing is worse than silence - so the control is still withheld (the
      // host said so) and the sentence is dropped.
      seedAttempt(withheldSwitchAttempt(null));
      renderActions(TURN_ID);

      expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
      const root = screen.getByRole("button", { name: "Retry" }).parentElement;
      expect(root?.textContent ?? "").not.toContain("No other model is set up");
    });
  });
});
