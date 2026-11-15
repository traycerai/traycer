/**
 * The team work a claim stops, as the app's claim confirm shows it (board
 * C13). `unknown` is a failed read, a null answer or a host that answers
 * unsupported; it is never read as `none`.
 */
export type RunningChats =
  | { readonly kind: "none" }
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "unknown" };

// The count comes from the `{ kind: "computer" }` subject of
// `environment.previewLocalFacts`, which is not on this stack yet.
export function readRunningChatCount(): Promise<RunningChats> {
  return Promise.resolve({ kind: "unknown" });
}
