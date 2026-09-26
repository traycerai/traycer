import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  FallbackWaitDisposition,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { FallbackRungRefusalDetail } from "@traycer/protocol/host/chat-fallback";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FallbackManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import type { RoutingDestinationPicker } from "@/components/chat/fallback/routing-destination-picker";
import { chatFallbackMutationKeys } from "@/lib/query-keys";
import { formatClockTime, formatResetDateTime } from "@/lib/relative-time";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  chatRunSettings,
  lastFailedAttempt,
} from "./fallback-fixtures";

const EPIC_ID = "epic-manual";
const CHAT_ID = "chat-manual";
const HOST_ID = "host-manual";
const TURN_ID = "turn-attempt";
const USER_MESSAGE_ID = "user-msg-attempt";
const RESETS_AT = new Date(2026, 5, 15, 15, 0, 0).getTime();

interface MockRungResponse {
  readonly outcome: string;
  readonly detail: FallbackRungRefusalDetail | null;
}

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
    chat: { readonly settings: ChatRunSettings | null } | null;
    publishConfirmedManualFallbackAction: (input: unknown) => void;
    publishUnattendedFallbackOutcome: (input: unknown) => void;
  };
  const initialSlice = (): Slice => ({
    lastFailedAttempt: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
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
  // Typed by its return rather than an `as`: a case sets the entry to null, and
  // the lint's autofix strips a widening assertion on a non-null literal.
  const hostEntry = (): { readonly label: string } | null => ({
    label: "Surya's MacBook",
  });
  return {
    mutate: vi.fn(),
    // `useIsMutating`'s answer, and the filters it was asked with.
    mutating: 0,
    mutatingArgs: [] as unknown[],
    // Every props object the stubbed chooser rendered with, newest last.
    pickerProps: [] as ComponentProps<typeof RoutingDestinationPicker>[],
    openSettings: vi.fn(),
    toast: vi.fn(),
    store,
    publishedActions,
    publishedUnattended,
    mutationResult: null as {
      readonly outcome: string;
      readonly detail: FallbackRungRefusalDetail | null;
    } | null,
    // The tab host record's directory entry: the refusal that names a machine
    // reads its label from here, never from the host's detail.
    hostEntry: hostEntry(),
    // Deferred mode, for the ONE thing a synchronous double cannot express:
    // the ORDER of the newer-turn frame and the host's answer. Every other case
    // here resolves inside `mutate`, which fixes that order to "answer first"
    // and therefore cannot reach MF11's failing sequence at all.
    deferResponses: false,
    pendingResponses: [] as Array<
      (result: {
        readonly outcome: string;
        readonly detail: FallbackRungRefusalDetail | null;
      }) => void
    >,
  };
});

vi.mock("sonner", () => ({
  toast: harness.toast,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

/**
 * `useFallbackModelLabels` alone - see `fallback-grace-card.test.tsx`'s copy of
 * this double for the argument, and `fallback-model-labels.test.tsx` for the
 * resolver's own rules. The real hook mounts TanStack queries this suite has no
 * `QueryClientProvider` for, and every model string pinned below would
 * otherwise depend on a catalogue fixture.
 *
 * `null` (the default) passes the slug through, which is what the resolver
 * degrades to with no catalogue; a `Map` keyed `harnessId:model` is the one
 * case that cares whether this card reads the resolver's answer.
 */
const modelLabelOverride = vi.hoisted(() => ({
  value: null as ReadonlyMap<string, string> | null,
}));

vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (harnessId: string, model: string) =>
        modelLabelOverride.value?.get(`${harnessId}:${model}`) ?? model,
    };
  },
);

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({ store: harness.store }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useIsMutating: (filters: unknown) => {
    harness.mutatingArgs.push(filters);
    return harness.mutating;
  },
}));

// The chooser has its own suite. Here it is a button that records what the row
// handed it and goes quiet the way the real trigger does.
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (
    props: ComponentProps<typeof RoutingDestinationPicker>,
  ) => {
    harness.pickerProps.push(props);
    return (
      <button
        type="button"
        data-variant={props.triggerVariant}
        disabled={props.triggerDisabled || !props.canAct}
      >
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
  useHostDirectoryEntry: () => harness.hostEntry,
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
    // Real `useState`, not a static `isPending: false` - the spinner + Retry/
    // Switch reordering behaviour reads `runManualRung.isPending` and
    // `.variables.rung` (both real TanStack fields), and a mutation that never
    // reports itself pending can never exercise either. Mirrors TanStack's own
    // shape closely enough for this file's purposes: `isPending` flips true the
    // instant `mutate` is called and false the instant the result is
    // delivered, `variables` is set alongside `isPending` and is only ever
    // read by production code while `isPending` is true (an `&&` short-circuit
    // in `fallback-manual-rungs.tsx`), so its value once settled is moot.
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
        // TanStack runs the hook-level onSuccess in addition to the per-call
        // one. The refusal note (per-call) and the announcer hand-off (hook-level) both depend on firing.
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
        const deliver = (result: MockRungResponse): void => {
          setState({ isPending: false, variables: undefined });
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
      isPending: state.isPending,
      variables: state.variables,
    };
  },
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

function lastPickerProps(): ComponentProps<typeof RoutingDestinationPicker> {
  const props = harness.pickerProps.at(-1);
  if (props === undefined) throw new Error("the chooser never rendered");
  return props;
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
    harness.mutating = 0;
    harness.mutatingArgs = [];
    harness.pickerProps = [];
    harness.store.setState({ chat: null });
    harness.openSettings.mockReset();
    harness.toast.mockReset();
    harness.mutationResult = null;
    harness.hostEntry = { label: "Surya's MacBook" };
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
    // Pass-through by default, so every model string pinned below reads back
    // the tuple it was seeded with.
    modelLabelOverride.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("draws Switch to…, Wait until and Retry for a fully eligible rate-limit attempt, the lead filled and the rest outlined", () => {
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
    const row = screen.getByTestId("failed-turn-actions");
    const buttons = within(row).getAllByRole("button");
    // The cause's order of usefulness: a spent quota is not cured by trying the
    // same account again, so the switch leads and Retry is the last resort.
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Switch to…",
      `Wait until ${formatClockTime(RESETS_AT)}`,
      "Retry",
    ]);
    expect(buttons.map((b) => b.getAttribute("data-variant"))).toEqual([
      "default",
      "outline",
      "outline",
    ]);
    const text = row.parentElement?.textContent ?? "";
    expect(text).not.toMatch(BANNED_VOCABULARY);
    expect(text).not.toContain("rate_limit");
    // The retired text-link entry into settings is gone from this card.
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
  });

  // The policy's wait cap reaches seven days, so "Wait until" needs its
  // weekday once the reset is that far out - the bare clock time alone would
  // name the wrong day.
  it("names Wait until with its weekday once the reset is a day or more away", () => {
    const farResetsAt = Date.now() + 4 * 24 * 60 * 60_000;
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ALL_RUNGS,
        resetsAt: farResetsAt,
        waitDisposition: "eligible",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this button is never found, since its name still carries the bare
    // clock time instead of the weekday-qualified form.
    expect(
      screen.getByRole("button", {
        name: `Wait until ${formatResetDateTime(farResetsAt)}`,
      }),
    ).toBeDefined();
  });

  // The negative twins of the case above, and the reason this card needed a
  // gate at all: `ErrorSegment` is DURABLE TRANSCRIPT, so this row mounts for
  // anyone who can open the chat, and `chat.fallback.runManualRung` is a plain
  // unary RPC with nothing client-side in front of it.
  //
  // A VIEWER of someone else's chat has no standing to steer it, now or after a
  // reconnect, so the actions are not drawn at all (spec Flow 4): greying them
  // with "Reconnecting…" would promise something that is not coming.
  it("draws no actions and no reconnecting label for a VIEWER, and dispatches nothing", () => {
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

    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(harness.mutate).not.toHaveBeenCalled();
    // The viewer's answer holds through a dropped stream too: settled for the
    // session, not "come back later".
    act(() => {
      seedActCapability({ canAct: false, connectionStatus: "reconnecting" });
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  // The control pair for the viewer case: the SAME fixture, only the capability
  // moves, so neither can pass because the buttons happened not to render.
  it("keeps the actions on screen, disabled, with Reconnecting… for an OWNER whose chat stream has dropped", () => {
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
    // stream-side hold in exactly this state, and this card agrees with it.
    seedActCapability({ canAct: true, connectionStatus: "reconnecting" });
    renderActions(TURN_ID);

    const retry = buttonNamed("Retry");
    expect(retry.disabled).toBe(true);
    expect(buttonNamed("Switch to…").disabled).toBe(true);
    expect(
      buttonNamed(`Wait until ${formatClockTime(RESETS_AT)}`).disabled,
    ).toBe(true);
    expect(screen.getByText("Reconnecting…")).toBeDefined();

    fireEvent.click(retry);
    expect(harness.mutate).not.toHaveBeenCalled();

    // And it comes back on its own when the stream does.
    act(() => {
      seedActCapability({ canAct: true, connectionStatus: "open" });
    });
    expect(buttonNamed("Retry").disabled).toBe(false);
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  it("treats a host that has not said who this reader is yet as reconnecting", () => {
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
    // An open stream with no `access` yet: not enough to dispatch on.
    harness.store.setState({ access: null, connectionStatus: "open" });
    renderActions(TURN_ID);

    expect(buttonNamed("Retry").disabled).toBe(true);
    expect(buttonNamed("Switch to…").disabled).toBe(true);
    expect(screen.getByText("Reconnecting…")).toBeDefined();
    fireEvent.click(buttonNamed("Retry"));
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  // F6: `describeWaitDisposition`'s sentence is shared by the card (`Body`'s
  // full-width line) AND the Switch… menu's empty state - one source, two
  // renderers - and nothing pinned either half.
  //
  // Uses `no_verified_reset` rather than `attempt_unavailable`: the latter
  // now returns `null` from `describeWaitDisposition` (the "Model routing"
  // rename also dropped the sentence itself - see that module) and so is no
  // longer a fixture that demonstrates two renderers sharing one source. The
  // null-sentence behaviour has its own pin below.
  it("states the wait disposition on the card", () => {
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
        waitDisposition: "no_verified_reset",
      }),
    );
    renderActions(TURN_ID);
    // Falsification: change `no_verified_reset`'s copy in
    // `describeWaitDisposition` and both assertions below go red - they are
    // pinned to the FIXED wording.
    expect(
      screen.getByText(
        "The provider hasn't said when this limit resets, so there's nothing to wait for.",
      ),
    ).toBeDefined();
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
    expect(screen.getByText("Checking when this limit resets…")).toBeDefined();
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
      screen.getByText("This limit resets later than Traycer is set to wait."),
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
        `This limit resets at ${formatClockTime(RESETS_AT)} — longer than Traycer is set to wait.`,
      ),
    ).toBeDefined();
  });

  // Same weekday rule as "Wait until": the boundary this sentence names is,
  // by construction, later than the policy's cap - up to seven days - so the
  // bare clock time is wrong here even more often than on the button.
  it("names the beyond-cap boundary with its weekday once it is a day or more away", () => {
    const farResetsAt = Date.now() + 4 * 24 * 60 * 60_000;
    seedAttempt(
      positiveAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        reason: "rate_limit",
        eligibleRungs: ["retry"],
        resetsAt: farResetsAt,
        waitDisposition: "beyond_cap",
      }),
    );
    renderActions(TURN_ID);
    const resetsAtLabel = formatResetDateTime(farResetsAt);
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this reads the bare clock time instead of the weekday-qualified form.
    expect(
      screen.getByText(
        `This limit resets at ${resetsAtLabel} — longer than Traycer is set to wait.`,
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
        "The provider hasn't said when this limit resets, so there's nothing to wait for.",
      ),
    ).toBeDefined();
  });

  // `attempt_unavailable` now returns `null` from `describeWaitDisposition`
  // (see that module: the withdrawn sentence claimed no cause and named no
  // remedy, so the honest copy is none) - the row renders no wait sentence at
  // all, silently. Retry still has to stay enabled and clickable beside that
  // silence: this is the control that would catch a regression back to a
  // sentence claiming something false about the account the message ran on.
  it("renders no wait sentence for attempt_unavailable, and keeps Retry enabled beside its absence", () => {
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
    // Falsification: revert the `attempt_unavailable` arm of
    // `describeWaitDisposition` to return a sentence instead of `null` - this
    // assertion must go red.
    expect(
      screen.queryByText("Waiting isn't available for this message."),
    ).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error("expected the Retry button");
    }
    expect(retry.disabled).toBe(false);
  });

  it("renders no action row when eligibleRungs is empty, and no settings link in its place", () => {
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
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wait until/ })).toBeNull();
    // The "Model routing" text link was retired from the card: the settings
    // entry is the routing card's gear, and an action-less failed row is not a
    // place to bring it back.
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Model routing" })).toBeNull();
  });

  it("renders nothing when lastFailedAttempt is undefined", () => {
    seedAttempt(undefined);
    renderActions(TURN_ID);
    // Falsification: delete the if (attempt === undefined) return null line — this assertion must go red.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
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

  it("renders the eligible rungs for an auth failure in the non-switch-lead order, Retry filled", () => {
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
    // Falsification: reinstate an auth early return - no button renders and
    // this goes red. Make `switchLeads` true for auth - the order flips.
    const buttons = screen.getAllByRole("button", {
      name: /^(Retry|Switch to…|Wait until )/,
    });
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Retry",
      "Switch to…",
      `Wait until ${formatClockTime(RESETS_AT)}`,
    ]);
    expect(buttons.map((b) => b.getAttribute("data-variant"))).toEqual([
      "default",
      "outline",
      "outline",
    ]);
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

  // The manual retry had no feedback of its own between the click and the
  // next frame - `disabled` was the only signal, and it read identically to
  // every other rung's mutation being in flight. `ManualRetryButton` now
  // carries its OWN inline spinner, driven by `retryInFlight` - `isPending`
  // AND `variables.rung === "retry"` - so a Switch pick in flight does not
  // light up a Retry button that never fired.
  it("shows the inline spinner on Retry only while ITS OWN mutation is in flight", () => {
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
    harness.deferResponses = true;
    renderActions(TURN_ID);

    const retry = buttonNamed("Retry");
    // No spinner before the click - falsification: render `inFlight` `true`
    // unconditionally and this goes red.
    expect(retry.querySelector('[aria-hidden="true"]')).toBeNull();

    fireEvent.click(retry);
    // Falsification: drop the `runManualRung.variables.rung === "retry"` half
    // of `retryInFlight` (leaving only `isPending`) - this still passes on its
    // own, but the next assertion (a Switch in flight) would then go red.
    expect(retry.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(harness.pendingResponses).toHaveLength(1);

    act(() => {
      harness.pendingResponses[0]({ outcome: "applied", detail: null });
    });
    // Delivered, not removed - the recorder only ever pushes. Clear it so the
    // Switch below is unambiguously the NEXT entry.
    harness.pendingResponses.length = 0;
    expect(retry.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  // F-reorder: Retry moves to AFTER the Switch… menu when the failure is
  // `rate_limit` or `billing` AND a switch is on offer - see `switchLeads`'s
  // own doc for why (retrying the same account for a spent quota is unlikely
  // to help, so the useful control leads).
  it("renders Retry after Switch… for rate_limit and billing when a switch is available", () => {
    // Built literally rather than through `positiveAttempt`, whose `reason`
    // is narrowed to `"rate_limit" | "auth"` (see its own type) - `billing`
    // is outside that, and reaches this row exactly the way `rate_limit`
    // does (both admit `retry`/`switch`/`wait_once`; only the presentation
    // and the reordering rule single billing out).
    for (const reason of ["rate_limit", "billing"] as const) {
      seedAttempt(
        lastFailedAttempt({
          userMessageId: USER_MESSAGE_ID,
          turnId: TURN_ID,
          failure: { reason },
          eligibleRungs: ["retry", "switch"],
          waitDisposition: "no_verified_reset",
          switchDisposition: "eligible",
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      );
      const { unmount } = renderActions(TURN_ID);
      const buttons = screen.getAllByRole("button", {
        name: /^(Retry|Switch to…)$/,
      });
      // Falsification: delete the `switchLeads` gate around `retryButton`'s
      // two placements in `fallback-manual-rungs.tsx` - Retry would render
      // first regardless of `reason`, and this goes red for both reasons.
      expect(
        buttons.map((b) => b.textContent),
        reason,
      ).toEqual(["Switch to…", "Retry"]);
      unmount();
    }
  });

  it("keeps Retry before Switch… for a reason outside the reordering rule, even with a switch available", () => {
    // `positiveAttempt` only builds `"rate_limit" | "auth"` failures (see its
    // own type), and `auth` is covered by its own case above - so a reason
    // OUTSIDE the reordering rule that is not one of those is built literally
    // here instead, the same way `withheldSwitchAttempt`'s sibling cases do.
    seedAttempt(
      lastFailedAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        failure: { reason: "model_unavailable" },
        eligibleRungs: ["retry", "switch"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "eligible",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    );
    renderActions(TURN_ID);
    const buttons = screen.getAllByRole("button", {
      name: /^(Retry|Switch to…)$/,
    });
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry", "Switch to…"]);
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
    // Settles the mutation immediately, so Retry's own pick does not leave
    // every affordance `busy` (disabled) for the Wait-until click that
    // follows it.
    harness.mutationResult = { outcome: "applied", detail: null };
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

  // The Switch… control is `RoutingDestinationPicker`; this suite stubs it and
  // pins the seam - what the row hands it. The chooser's own behaviour (rows,
  // confirm, refusals, the lease) is `routing-destination-picker.test.tsx`.
  it("hands the Switch… chooser a failed-turn entry: the attempt and its own failed tuple", () => {
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
    const props = lastPickerProps();
    expect(props.entry.kind).toBe("failed-turn");
    if (props.entry.kind !== "failed-turn") return;
    expect(props.entry.attempt.userMessageId).toBe(USER_MESSAGE_ID);
    expect(props.entry.attempt.turnId).toBe(TURN_ID);
    expect(props.entry.seedTuple).toEqual(FAILED_CLAUDE_TUPLE);
    expect(props.triggerLabel).toBe("Switch to…");
    expect(props.canAct).toBe(true);
    expect(props.epicId).toBe(EPIC_ID);
    expect(props.chatId).toBe(CHAT_ID);
    expect(props.hostId).toBe(HOST_ID);
  });

  it("seeds the chooser from the chat's own settings when the host named no failed tuple", () => {
    harness.store.setState({ chat: { settings: DEFAULT_SHAPED_TUPLE } });
    seedAttempt(
      lastFailedAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ALL_RUNGS,
        waitDisposition: "no_verified_reset",
        switchDisposition: "eligible",
        failedTuple: null,
      }),
    );
    renderActions(TURN_ID);
    const props = lastPickerProps();
    expect(props.entry.kind).toBe("failed-turn");
    if (props.entry.kind !== "failed-turn") return;
    expect(props.entry.seedTuple).toEqual(DEFAULT_SHAPED_TUPLE);
  });

  it("offers no Switch… when neither the attempt nor the chat has a tuple to seed from", () => {
    harness.store.setState({ chat: { settings: null } });
    seedAttempt(
      lastFailedAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ALL_RUNGS,
        waitDisposition: "no_verified_reset",
        switchDisposition: "eligible",
        failedTuple: null,
      }),
    );
    renderActions(TURN_ID);
    expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("quiets Retry, Wait until and the Switch… trigger while ANY runManualRung for the chat is in flight", () => {
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
    // A rung the CHOOSER sent: this hook instance is not the one pending, so
    // only the shared mutation key can tell the bare buttons about it.
    harness.mutating = 1;
    renderActions(TURN_ID);
    expect(harness.mutatingArgs).toContainEqual({
      mutationKey: chatFallbackMutationKeys.runManualRung(CHAT_ID),
    });
    expect(buttonNamed("Retry").disabled).toBe(true);
    expect(
      buttonNamed(`Wait until ${formatClockTime(RESETS_AT)}`).disabled,
    ).toBe(true);
    expect(buttonNamed("Switch to…").disabled).toBe(true);
    fireEvent.click(buttonNamed("Retry"));
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  // Spec Flow 4: a toast never carries a refusal. The answer is written where
  // the button was, as a status note, and nothing goes to sonner.
  it("answers a refused Retry inline with the literal sentence, never a toast, and keeps every button", () => {
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
    harness.mutationResult = { outcome: "rung_unavailable", detail: null };
    renderActions(TURN_ID);
    expect(screen.queryByTestId("failed-turn-refusal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Falsification: put the `toast(message)` line back in
    // `useFallbackRunManualRung`'s hook-level onSuccess and this goes red.
    expect(harness.toast).not.toHaveBeenCalled();
    const note = screen.getByTestId("failed-turn-refusal");
    expect(note.getAttribute("role")).toBe("status");
    // No detail from an older host: the neutral sentence for the action, not
    // the shared outcome sentence and not a cause.
    expect(note.textContent).toBe("Couldn't retry just now.");
    expect(buttonNamed("Retry").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Switch to…" })).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    ).toBeDefined();
    // The inline surface answers, so the announcer stays quiet.
    expect(harness.publishedUnattended).toEqual([]);
  });

  it("answers a refused Wait until inline too, with the wait's own neutral sentence", () => {
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
    harness.mutationResult = { outcome: "rung_unavailable", detail: null };
    renderActions(TURN_ID);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    );
    expect(harness.toast).not.toHaveBeenCalled();
    expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
      "Couldn't start the wait just now.",
    );
  });

  it("clears the note when the next press starts", () => {
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
    harness.mutationResult = { outcome: "rung_unavailable", detail: null };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByTestId("failed-turn-refusal")).toBeDefined();
    harness.deferResponses = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByTestId("failed-turn-refusal")).toBeNull();
  });

  it("says the chat moved on, with the next step, and draws no buttons, for attempt_not_latest", () => {
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
    harness.mutationResult = { outcome: "attempt_not_latest", detail: null };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.toast).not.toHaveBeenCalled();
    expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
      "This chat has moved on since that message. Send a new message to continue.",
    );
    expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  /**
   * One render per refusal kind (spec Flow 4's table): the sentence the card
   * writes, and the buttons it leaves. The expectations are literal and NOT read
   * from the copy module, so a change to the module is a change here.
   *
   * The names are the buttons drawn after the refusal, in order, for a
   * `rate_limit` attempt offering all three actions - so `Switch to…` leads and
   * `Retry` is last, and dropping one shows as a shorter list rather than a
   * different render.
   */
  describe("a refusal, by kind", () => {
    const WAIT = `Wait until ${formatClockTime(RESETS_AT)}`;
    const ALL = ["Switch to…", WAIT, "Retry"];
    const REFUSALS: ReadonlyArray<{
      readonly kind: string;
      readonly text: string | null;
      readonly left: ReadonlyArray<string>;
    }> = [
      {
        kind: "turn_running",
        text: "This chat is busy. The actions come back when the current turn ends.",
        left: [],
      },
      { kind: "routing_active", text: null, left: [] },
      {
        kind: "worktree_missing",
        text: "This chat's worktree no longer exists on Surya's MacBook. Start a new chat from this task.",
        left: [],
      },
      {
        kind: "no_workspace",
        text: "This chat has no folder to run in any more. Start a new chat from this task.",
        left: [],
      },
      {
        kind: "message_changed",
        text: "The original message changed, so it can't be replayed. Send it again from the composer.",
        left: [],
      },
      {
        kind: "prelaunch_failed",
        text: "Couldn't start the replacement turn. Try again, or switch.",
        left: ["Switch to…", "Retry"],
      },
      {
        kind: "reset_passed",
        text: "That limit has reset. Retry instead.",
        left: ["Switch to…", "Retry"],
      },
      {
        kind: "no_verified_reset",
        text: "The provider hasn't said when this limit resets, so there's nothing to wait for.",
        left: ["Switch to…", "Retry"],
      },
      {
        kind: "host_unavailable",
        text: "This chat's host is restarting. Try again in a moment.",
        left: ALL,
      },
      {
        kind: "settings_missing",
        text: "This chat has no model set. Pick one in the composer and send again.",
        left: [],
      },
      {
        kind: "storage_failed",
        text: "Couldn't save this chat's state just now. Try again.",
        left: ALL,
      },
      {
        kind: "target_unusable",
        text: "That model can't be used right now. Pick another.",
        left: ["Switch to…"],
      },
    ];

    function refuse(input: {
      readonly kind: string;
      readonly retryable: boolean;
      readonly label: string;
    }): void {
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
      harness.mutationResult = {
        outcome: "rung_unavailable",
        detail: {
          kind: input.kind,
          label: input.label,
          retryable: input.retryable,
        },
      };
      renderActions(TURN_ID);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    }

    function buttonsLeft(): ReadonlyArray<string | null> {
      return screen.queryAllByRole("button").map((b) => b.textContent);
    }

    it.each(REFUSALS)(
      "$kind writes its sentence and leaves $left",
      ({ kind, text, left }) => {
        refuse({ kind, retryable: false, label: "the host's own label" });
        expect(harness.toast).not.toHaveBeenCalled();
        if (text === null) {
          // The routing card on screen is the explanation; a second line here
          // would be the same fact twice.
          expect(screen.queryByTestId("failed-turn-refusal")).toBeNull();
        } else {
          expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
            text,
          );
        }
        expect(buttonsLeft()).toEqual(left);
        if (left.length === 0) {
          expect(screen.queryByTestId("failed-turn-actions")).toBeNull();
        } else {
          // The lead is still exactly one filled button after a refusal took
          // some away: the next action steps up rather than leaving no primary.
          const filled = screen
            .getAllByRole("button")
            .filter((b) => b.getAttribute("data-variant") === "default");
          expect(filled.map((b) => b.textContent)).toEqual([left[0]]);
        }
      },
    );

    it.each(REFUSALS)(
      "$kind keeps every button when the host says pressing again can work",
      ({ kind }) => {
        refuse({ kind, retryable: true, label: "the host's own label" });
        // The two kinds that say the chat is busy hide the row whatever the
        // host says; the host brings the actions back itself.
        const busy = kind === "turn_running" || kind === "routing_active";
        expect(buttonsLeft()).toEqual(busy ? [] : ALL);
      },
    );

    it("renders the host's label for the residue kind and keeps every button", () => {
      refuse({
        kind: "unknown",
        retryable: false,
        label: "Something unexpected happened.",
      });
      expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
        "Something unexpected happened.",
      );
      expect(buttonsLeft()).toEqual(ALL);
    });

    it("renders the host's label for a kind this build has never heard of", () => {
      refuse({
        kind: "a_kind_from_a_newer_host",
        retryable: false,
        label: "The newer host's sentence.",
      });
      expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
        "The newer host's sentence.",
      );
      expect(buttonsLeft()).toEqual(ALL);
    });

    it("says the neutral sentence, with Retry still enabled, when the host's label is blank", () => {
      refuse({ kind: "unknown", retryable: false, label: "  " });
      expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
        "Couldn't retry just now.",
      );
      expect(buttonNamed("Retry").disabled).toBe(false);
      expect(buttonsLeft()).toEqual(ALL);
    });

    it("names the machine from the tab host record, and omits it without one", () => {
      harness.hostEntry = null;
      refuse({
        kind: "worktree_missing",
        retryable: false,
        label: "Some other machine",
      });
      expect(screen.getByTestId("failed-turn-refusal").textContent).toBe(
        "This chat's worktree no longer exists on its host. Start a new chat from this task.",
      );
    });

    it("carries no banned word and no raw code on any refusal sentence", () => {
      for (const { kind } of REFUSALS) {
        refuse({ kind, retryable: false, label: "the host's own label" });
        const note = screen.queryByTestId("failed-turn-refusal");
        if (note !== null) {
          expect(note.textContent).not.toMatch(BANNED_VOCABULARY);
          expect(note.textContent).not.toMatch(/fallback/i);
          expect(note.textContent).not.toContain(kind);
        }
        cleanup();
        harness.mutate.mockReset();
      }
    });
  });

  it("hands a refusal to the chat's announcer when the card is gone before the host answers", () => {
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
    harness.deferResponses = true;
    const { unmount } = renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.pendingResponses).toHaveLength(1);
    // A newer turn removed the row under the press - what `attempt_not_latest`
    // MEANS - and the host answers a beat later.
    unmount();
    harness.pendingResponses[0]({
      outcome: "attempt_not_latest",
      detail: null,
    });
    // Never a toast, and not lost either: one channel, the announcer.
    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.publishedUnattended).toEqual([
      {
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        text: "This chat has moved on since that message. Send a new message to continue.",
      },
    ]);
  });

  it("publishes a confirmed action, and nothing else, when the press applies", () => {
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
    harness.mutationResult = { outcome: "applied", detail: null };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.toast).not.toHaveBeenCalled();
    expect(screen.queryByTestId("failed-turn-refusal")).toBeNull();
    expect(harness.publishedUnattended).toEqual([]);
    expect(harness.publishedActions).toHaveLength(1);
  });

  // The lead by cause, and exactly one filled button in every arrangement.
  describe("the lead action", () => {
    const CAUSES: ReadonlyArray<{
      readonly reason:
        | "rate_limit"
        | "billing"
        | "model_unavailable"
        | "provider_unavailable";
      readonly order: ReadonlyArray<string>;
    }> = [
      {
        reason: "rate_limit",
        order: [
          "Switch to…",
          `Wait until ${formatClockTime(RESETS_AT)}`,
          "Retry",
        ],
      },
      {
        reason: "billing",
        order: [
          "Switch to…",
          `Wait until ${formatClockTime(RESETS_AT)}`,
          "Retry",
        ],
      },
      {
        reason: "model_unavailable",
        order: [
          "Retry",
          "Switch to…",
          `Wait until ${formatClockTime(RESETS_AT)}`,
        ],
      },
      {
        reason: "provider_unavailable",
        order: [
          "Retry",
          "Switch to…",
          `Wait until ${formatClockTime(RESETS_AT)}`,
        ],
      },
    ];

    it.each(CAUSES)(
      "orders $reason as $order with one default button first",
      ({ reason, order }) => {
        seedAttempt(
          lastFailedAttempt({
            userMessageId: USER_MESSAGE_ID,
            turnId: TURN_ID,
            failure: {
              reason,
              resetsAt: RESETS_AT,
              resetsAtSource: "provider",
            },
            eligibleRungs: ALL_RUNGS,
            waitDisposition: "eligible",
            switchDisposition: "eligible",
            failedTuple: FAILED_CLAUDE_TUPLE,
          }),
        );
        renderActions(TURN_ID);
        const buttons = within(
          screen.getByTestId("failed-turn-actions"),
        ).getAllByRole("button");
        expect(buttons.map((b) => b.textContent)).toEqual(order);
        // Exactly one default; the rest outline. Never ghost or secondary.
        expect(buttons.map((b) => b.getAttribute("data-variant"))).toEqual([
          "default",
          "outline",
          "outline",
        ]);
      },
    );

    it("steps the next action up to the lead when the lead is not on offer", () => {
      // A rate limit with no destination: the switch is withheld, so the wait
      // leads rather than leaving a row with no filled button.
      seedAttempt(
        lastFailedAttempt({
          userMessageId: USER_MESSAGE_ID,
          turnId: TURN_ID,
          failure: {
            reason: "rate_limit",
            resetsAt: RESETS_AT,
            resetsAtSource: "provider",
          },
          eligibleRungs: ["retry", "wait_once"],
          waitDisposition: "eligible",
          switchDisposition: "no_destination",
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      );
      renderActions(TURN_ID);
      const buttons = within(
        screen.getByTestId("failed-turn-actions"),
      ).getAllByRole("button");
      expect(
        buttons.map((b) => [b.textContent, b.getAttribute("data-variant")]),
      ).toEqual([
        [`Wait until ${formatClockTime(RESETS_AT)}`, "default"],
        ["Retry", "outline"],
      ]);
    });

    it("hands the Switch to… chooser the same variant the row drew for it", () => {
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
      expect(lastPickerProps().triggerVariant).toBe("default");
    });
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

      expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
      // The row is not merely bare - `retry` survives. A card that lost every
      // control would satisfy the line above with the whole DTO withheld.
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

      // Two levels up: the explanation now renders in its own band
      // (`ManualRungExplanations`) above the button row, a sibling of the
      // buttons' own row rather than a peer inside it - see that component's
      // doc. `retry`'s immediate parent is only the button row; the card-level
      // container is the grandparent both bands share.
      const root = screen.getByRole("button", { name: "Retry" }).parentElement
        ?.parentElement;
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

    /**
     * The same sentence with a SLUG-shaped model, which `DEFAULT_SHAPED_TUPLE`
     * cannot show: "default" is already a word a user reads.
     *
     * This card's own destination menu resolves its rows, and the grace card
     * one state earlier resolves its tuples - so an unresolved subject here was
     * the one surface in the chat still printing a provider's internal
     * identifier at a user being asked to decide something.
     */
    it("names the chat by its catalogue model label, not the raw slug", () => {
      modelLabelOverride.value = new Map([
        ["claude:claude-fable-5-1[1m]", "Claude Fable"],
      ]);
      seedAttempt(
        withheldSwitchAttempt(
          chatRunSettings({
            harnessId: "claude",
            model: "claude-fable-5-1[1m]",
            profileId: null,
          }),
        ),
      );
      renderActions(TURN_ID);

      const root = screen.getByRole("button", { name: "Retry" }).parentElement
        ?.parentElement;
      const text = root?.textContent ?? "";
      // Falsification: drop `modelLabelFor` from this card's
      // `fallbackProviderModelLabel` call and this goes red - the sentence
      // reads "…for Claude Code · claude-fable-5-1[1m]".
      expect(text).toContain(
        "No other model is set up for Claude Code · Claude Fable",
      );
      expect(text).not.toContain("claude-fable-5-1[1m]");
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

      expect(screen.getByRole("button", { name: "Switch to…" })).toBeDefined();
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

      expect(screen.getByRole("button", { name: "Switch to…" })).toBeDefined();
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

      expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
      const root = screen.getByRole("button", { name: "Retry" }).parentElement;
      expect(root?.textContent ?? "").not.toContain("No other model is set up");
    });
  });
});
