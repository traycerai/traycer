import { appLogger } from "@/lib/logger";

/** Terminal handler for an epic mutation chain a surface deliberately detaches. */
export function settleDetachedEpicMutation(
  work: Promise<unknown>,
  surface: string,
  stage: string,
): void {
  void work.catch((error: unknown) => {
    appLogger.warn("detached epic mutation failed", {
      surface,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
