/**
 * The dispatch-time refusal: a first-page fetch resumed from its request-
 * context wait (or a cursor page dispatched) after the session's cloud verdict
 * was withdrawn, and the request would have been a cloud spend on the retained
 * bearer. Terminal for the production QueryClient like the timeout error: a
 * retry would only re-ask the same store and be refused again, and the hook
 * has already moved the surface to its disabled key.
 */
export class CloudEpicTasksVerdictWithdrawnError extends Error {
  constructor() {
    super(
      "Cloud epic tasks request refused: the session no longer holds a cloud verdict.",
    );
    this.name = "CloudEpicTasksVerdictWithdrawnError";
  }
}
