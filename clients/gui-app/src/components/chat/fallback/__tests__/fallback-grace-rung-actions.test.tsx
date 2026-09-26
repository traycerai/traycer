import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackGraceRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { FAILED_CLAUDE_TUPLE, lastFailedAttempt } from "./fallback-fixtures";

const EPIC_ID = "epic-grace-rung";
const CHAT_ID = "chat-grace-rung";
const HOST_ID = "host-grace-rung";
const TURN_ID = "turn-grace-rung";
const USER_MESSAGE_ID = "user-msg-grace-rung";

/**
 * The chat-session slice `useChatLastFailedAttempt` reads, and the mutation
 * double `ManualRungAffordances` reaches through `useFallbackRunManualRung`.
 * Mirrors `fallback-manual-rungs.test.tsx`'s own harness - this file needs
 * only the pieces `FallbackGraceRungActions` actually exercises: no
 * `turnId`/`TabHostProvider` gate (the grace card is one per chat and takes
 * its props directly, not through `ChatTranscriptContext`), and no
 * `use-fallback-targets` double, since a `grace_card` surface never mounts
 * `<RoutingDestinationPicker>` from the row (see `surface`'s own doc on
 * `ManualRungAffordances`). `useIsMutating` is doubled to 0 because the row
 * reads it through a QueryClient this suite does not stand up.
 */
const harness = vi.hoisted(() => {
  type Slice = {
    lastFailedAttempt: LastFailedAttempt | undefined;
    access: { readonly canAct: boolean } | null;
    connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
    chat: null;
    publishConfirmedManualFallbackAction: (input: unknown) => void;
    publishUnattendedFallbackOutcome: (input: unknown) => void;
  };
  const initialSlice = (): Slice => ({
    lastFailedAttempt: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
    publishConfirmedManualFallbackAction: () => {},
    publishUnattendedFallbackOutcome: () => {},
  });
  let state: Slice = initialSlice();
  const listeners = new Set<() => void>();
  const store = {
    getState: (): Slice => state,
    getInitialState: (): Slice => initialSlice(),
    setState: (next: Partial<Slice>): Slice => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { mutate: vi.fn(), store };
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  // The row reads "is any rung in flight" through the QueryClient; this suite
  // mocks the mutation itself and has no client, so nothing is ever in flight.
  useIsMutating: () => 0,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({ store: harness.store }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
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
        `${harnessId}:${model}`,
    };
  },
);

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    options: {
      readonly onSuccess:
        | ((data: { readonly outcome: string }, variables: unknown) => void)
        | undefined;
    },
  ) => ({
    mutate: (variables: unknown) => {
      harness.mutate(variables);
      options.onSuccess?.({ outcome: "applied" }, variables);
    },
    isPending: false,
  }),
}));

function seedAttempt(attempt: LastFailedAttempt | undefined): void {
  harness.store.setState({ lastFailedAttempt: attempt });
}

function attemptWithRungs(
  eligibleRungs: ReadonlyArray<"retry" | "switch" | "wait_once">,
): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: USER_MESSAGE_ID,
    turnId: TURN_ID,
    failure: { reason: "rate_limit" },
    eligibleRungs,
    waitDisposition: "no_verified_reset",
    switchDisposition: eligibleRungs.includes("switch")
      ? "eligible"
      : "unknown",
    failedTuple: FAILED_CLAUDE_TUPLE,
  });
}

function renderGraceRungActions() {
  return render(
    <TabHostProvider hostId={HOST_ID}>
      <FallbackGraceRungActions
        epicId={EPIC_ID}
        chatId={CHAT_ID}
        hostId={HOST_ID}
        client={null}
      />
    </TabHostProvider>,
  );
}

describe("FallbackGraceRungActions", () => {
  beforeEach(() => {
    harness.mutate.mockReset();
    seedAttempt(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  // The whole point of this component: a user who fixed the failure by hand
  // during the grace countdown can say so from the card itself, instead of
  // watching the switch happen with no way to answer "I already fixed it".
  it("renders Retry when the host offers lastFailedAttempt during hold", () => {
    seedAttempt(attemptWithRungs(["retry", "switch", "wait_once"]));
    renderGraceRungActions();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  // `hold` is the one state the host defines `lastFailedAttempt` for while a
  // traversal is still live (`fallbackHeldFailureFor`); every other
  // dispatch-holding state clears it. This component does not second-guess
  // which state produced the value - it renders what the host named, or
  // nothing at all.
  it("renders nothing when the host offers no attempt", () => {
    seedAttempt(undefined);
    renderGraceRungActions();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
  });

  // The load-bearing negative: the grace card's own `menu` slot
  // (`<RoutingDestinationPicker>`, holding the countdown while the
  // popover is open) is the switch control here. `ManualRungAffordances`
  // must never draw its OWN `Switch…` trigger for `surface: "grace_card"`,
  // even when the attempt's `eligibleRungs` includes `"switch"` - two switch
  // controls side by side would put the wrong one (the leaseless one) next
  // to the leased one.
  it("does NOT render a second switch control even when switch is eligible", () => {
    seedAttempt(attemptWithRungs(["retry", "switch", "wait_once"]));
    renderGraceRungActions();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    // Falsification: drop the `surface === "grace_card"` gate on `offersSwitch`
    // in `fallback-manual-rungs.tsx` - this goes red, a second "Switch…"
    // trigger appears beside the grace card's own leased menu.
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
  });

  // `auth` is link-only on this card too - "Sign in instead" is already the
  // control that says so, and a retry against a signed-out account would
  // send the identical request to the identical account.
  it("renders nothing for an auth failure, even when eligibleRungs names retry", () => {
    seedAttempt(
      lastFailedAttempt({
        userMessageId: USER_MESSAGE_ID,
        turnId: TURN_ID,
        failure: { reason: "auth" },
        eligibleRungs: ["retry"],
        waitDisposition: "attempt_unavailable",
        switchDisposition: "unknown",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    );
    renderGraceRungActions();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("sends runManualRung retry with the attempt's ids", () => {
    seedAttempt(attemptWithRungs(["retry"]));
    renderGraceRungActions();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "retry",
      target: null,
      userMessageId: USER_MESSAGE_ID,
      turnId: TURN_ID,
    });
  });
});
