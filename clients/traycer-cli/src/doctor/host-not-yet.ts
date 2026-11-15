import { RetryableTransportError } from "../../../shared/host-transport/host-messenger";

/**
 * How long doctor keeps asking a host that answers "not yet", from its first
 * attempt. A team's computer answers so for the length of a file write as it
 * starts; one that is still answering it after this is reported as a host
 * that could not give its verdict, never as one that is not responding.
 */
const HOST_NOT_YET_BOUND_MS = 5_000;

/**
 * The pause before asking again: short against the start-up instant it waits
 * out, long enough that a host still saying "not yet" is asked about ten times
 * within the bound rather than flooded.
 */
const HOST_NOT_YET_RETRY_WAIT_MS = 500;

/**
 * The host's own answer that it cannot serve this yet and the call may be
 * tried again: a retryable refusal at the open, or a retryable error answered
 * on an admitted session. Either carries the host's code in `fatalDetails`; a
 * host that did not answer leaves it `null`.
 */
export function isHostNotYet(error: unknown): boolean {
  return (
    error instanceof RetryableTransportError &&
    error.fatalDetails?.retryable === true
  );
}

/**
 * Runs `call`, and again after a short wait while the host answers "not yet",
 * until {@link HOST_NOT_YET_BOUND_MS} after the first attempt; then returns or
 * throws what the last attempt gave. Any other failure is thrown at once, so a
 * host that does not answer costs no more time than before.
 */
export async function retryWhileHostNotYet<Result>(
  call: () => Promise<Result>,
): Promise<Result> {
  const deadline = Date.now() + HOST_NOT_YET_BOUND_MS;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (
        !isHostNotYet(error) ||
        Date.now() + HOST_NOT_YET_RETRY_WAIT_MS >= deadline
      )
        throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, HOST_NOT_YET_RETRY_WAIT_MS);
      });
    }
  }
}
