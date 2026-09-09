import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FallbackWaitDisposition,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFallbackListTargetsResponse } from "@traycer/protocol/host/chat-fallback";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FallbackManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import { describeFallbackOutcome } from "@/components/chat/fallback/fallback-copy";
import { formatClockTime } from "@/lib/relative-time";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
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

const harness = vi.hoisted(() => {
  // The published confirmed actions, in order. The announcer reads this slot
  // for real; here it is a recorder so a case can assert what was published.
  const publishedActions: unknown[] = [];
  // `publishConfirmedManualFallbackAction` is part of the slice, not an extra
  // on the double: the component reaches it through
  // `handle.store.getState()`, so a slice that omits it fails as
  // "publishConfirmedManualFallbackAction is not a function" thrown INSIDE
  // `use-confirmed-manual-action.ts` - a fixture gap wearing a production
  // stack trace, which is the same class as the under-modelled `onSuccess`
  // below.
  type Slice = {
    lastFailedAttempt: LastFailedAttempt | undefined;
    publishConfirmedManualFallbackAction: (input: unknown) => void;
  };
  const initialSlice = (): Slice => ({
    lastFailedAttempt: undefined,
    publishConfirmedManualFallbackAction: (input: unknown): void => {
      publishedActions.push(input);
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
    listCalls: [] as Array<{
      readonly enabled: boolean;
      readonly selector: unknown;
    }>,
    listData: undefined as ChatFallbackListTargetsResponse | undefined,
    mutationResult: null as { readonly outcome: string } | null,
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
      const result = harness.mutationResult;
      if (result === null) return;
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
      if (args.onSuccess !== undefined) {
        args.onSuccess(result, vars);
      }
      if (opts !== undefined && opts.onSuccess !== undefined) {
        opts.onSuccess(result, vars);
      }
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
  });
}

const ALL_RUNGS: ReadonlyArray<"retry" | "switch" | "wait_once"> = [
  "retry",
  "switch",
  "wait_once",
];

function seedAttempt(attempt: LastFailedAttempt | undefined): void {
  harness.store.setState({ lastFailedAttempt: attempt });
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
    const refusal = describeFallbackOutcome("rung_unavailable");
    if (refusal === null) {
      throw new Error("expected copy for rung_unavailable");
    }
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Switch…" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Codex · gpt-5/ }));
    });
    expect(screen.getByText(refusal)).toBeDefined();
    expect(screen.getByRole("button", { name: /Codex · gpt-5/ })).toBeDefined();
    // Falsification: restore onSuccess: toastFallbackOutcome on the useFallbackRunManualRung hook and this assertion must go red.
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

  it("toasts a Retry refusal with the describeFallbackOutcome text", () => {
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
    const refusal = describeFallbackOutcome("rung_unavailable");
    if (refusal === null) {
      throw new Error("expected copy for rung_unavailable");
    }
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Falsification: drop the per-call onSuccess from the run() call site and this must go red.
    expect(harness.toast).toHaveBeenCalledWith(refusal);
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
    const refusal = describeFallbackOutcome("rung_unavailable");
    if (refusal === null) {
      throw new Error("expected copy for rung_unavailable");
    }
    harness.mutationResult = { outcome: "rung_unavailable" };
    renderActions(TURN_ID);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Wait until ${formatClockTime(RESETS_AT)}`,
      }),
    );
    expect(harness.toast).toHaveBeenCalledWith(refusal);
  });
});
