/**
 * The one-attempt local RequestContext admission deadline, not a host failure.
 * Retrying would start another full wait and exceed the bounded 15-second
 * admission policy, so the production QueryClient treats it as terminal while
 * retaining normal retries for a dispatched host request.
 */
export class CloudEpicTasksRequestContextTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Cloud epic tasks request context did not match within ${timeoutMs}ms.`,
    );
    this.name = "CloudEpicTasksRequestContextTimeoutError";
  }
}
