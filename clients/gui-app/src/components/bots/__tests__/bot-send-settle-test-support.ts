/**
 * What "a send has been answered and the app has heard it" means in a test.
 *
 * The effects the sent-post suites assert (a row dropped, a text put back in
 * the box, a rail closed or moved) run in the app's own continuation on the
 * mutation's promise: `send.mutateAsync(variables).then(...)` in the box and
 * `sendAgain(attempt).then(...)` in a row's Retry. The mutation's lifecycle
 * ends before them, so `isMutating() === 0` and a fixed number of microtask
 * ticks both say "done" too early. Wrapping the real send mutation records
 * each call's promise, which is the promise the app reacts on. A reaction
 * registered on it later runs after the app's own, because a promise runs its
 * reactions in registration order, including a handler that returns early.
 */
import { useCallback } from "react";
import {
  CancelledError,
  type UseMutateAsyncFunction,
  type UseMutationResult,
} from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { expect } from "vitest";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import {
  heldHost,
  type HeldSend,
} from "@/components/bots/__tests__/bot-sent-post-scene";
import type { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";

type SendMutationHook = typeof useBotConversationSendMutation;

interface RecordedSend {
  readonly request: BotConversationSendRequest;
  readonly promise: Promise<unknown>;
  settled: boolean;
  /** What the promise rejected with, once it has. */
  rejection: unknown;
}

/** Every call the app made to `mutateAsync` in this case, in order. */
let recorded: RecordedSend[] = [];

/** How many sends the app has made in this case. */
export function recordedSendCount(): number {
  return recorded.length;
}

/** Forgets the calls of the case before. */
export function resetRecordedSends(): void {
  recorded = [];
}

function useRecordedSendMutation<
  TData,
  TError,
  TVariables extends { readonly request: BotConversationSendRequest },
  TContext,
>(
  result: UseMutationResult<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const { mutateAsync: real } = result;
  // Its identity is a dependency of the app's memoised rows: keep it as stable
  // as the real one.
  const mutateAsync = useCallback<
    UseMutateAsyncFunction<TData, TError, TVariables, TContext>
  >(
    (variables, options) => {
      const promise = real(variables, options);
      const entry: RecordedSend = {
        request: variables.request,
        promise,
        settled: false,
        rejection: undefined,
      };
      recorded.push(entry);
      promise.then(
        () => {
          entry.settled = true;
        },
        (error: unknown) => {
          entry.settled = true;
          entry.rejection = error;
        },
      );
      return promise;
    },
    [real],
  );
  return { ...result, mutateAsync };
}

/**
 * The module the suites' `vi.mock("@/hooks/bots/use-bot-mutations")` returns:
 * the real one, whose send mutation records its calls.
 */
export function withRecordedSends<
  T extends { useBotConversationSendMutation: SendMutationHook },
>(original: T): T {
  return {
    ...original,
    useBotConversationSendMutation: (client) =>
      useRecordedSendMutation(original.useBotConversationSendMutation(client)),
  };
}

function noop(): void {
  // A reaction that only waits.
}

/**
 * Lets the host answer `target`, and waits until the app has heard it: the
 * reaction here runs after the app's own on the same promise, so what the
 * handler did synchronously (the stores, the box's state) is done when it
 * returns, and the surrounding `act` renders it. Work the handler starts that
 * lands later (a route step, a refetch) is not covered: the case waits for it
 * on what it shows.
 *
 * `held` is the host's list of the sends it holds. A Retry sends the same
 * nonce again, so the held send is matched to the app's call by its place
 * among the sends of that nonce, not by the nonce alone. The call must still
 * be pending when it is answered.
 */
export async function settleHeldSend<
  T extends { readonly request: BotConversationSendRequest },
>(held: ReadonlyArray<T>, target: T, answer: () => void): Promise<void> {
  const call = callFor(held, target);
  expect(
    call.settled,
    "the send was answered before the case answered it",
  ).toBe(false);
  await act(async () => {
    answer();
    await call.promise.then(noop, noop);
  });
}

/**
 * The account change cancels every send still out, so the host's answer after
 * it reaches a promise nobody is waiting on: what the app heard was the
 * cancellation, at the change. This lets the host answer anyway, as a real
 * host would, and waits until the app's handler has run for the
 * cancellation, which is what the case asserts the effect of.
 */
export async function settleCancelledSend<
  T extends { readonly request: BotConversationSendRequest },
>(held: ReadonlyArray<T>, target: T, answer: () => void): Promise<void> {
  const call = callFor(held, target);
  expect(
    call.rejection,
    "the account change did not cancel the send",
  ).toBeInstanceOf(CancelledError);
  await act(async () => {
    answer();
    await call.promise.then(noop, noop);
  });
}

/** The app's call for the send the host holds as `target`. */
function callFor<T extends { readonly request: BotConversationSendRequest }>(
  held: ReadonlyArray<T>,
  target: T,
): RecordedSend {
  const sameNonce = (request: BotConversationSendRequest): boolean =>
    request.sendNonce === target.request.sendNonce;
  const occurrence = held
    .filter((send) => sameNonce(send.request))
    .indexOf(target);
  expect(occurrence, "the host does not hold that send").toBeGreaterThanOrEqual(
    0,
  );
  const call = recorded
    .filter((send) => sameNonce(send.request))
    .at(occurrence);
  if (call === undefined) {
    throw new Error("the app made no call for the send the host holds");
  }
  return call;
}

/**
 * `settleHeldSend` over the sent-post scene's host: `answer` is given the held
 * send `target`.
 */
export function settleSceneSend(
  target: HeldSend,
  answer: (held: HeldSend) => void,
): Promise<void> {
  return settleHeldSend(heldHost().sends, target, () => answer(target));
}

/** `settleCancelledSend` over the sent-post scene's host. */
export function settleCancelledSceneSend(
  target: HeldSend,
  answer: (held: HeldSend) => void,
): Promise<void> {
  return settleCancelledSend(heldHost().sends, target, () => answer(target));
}
