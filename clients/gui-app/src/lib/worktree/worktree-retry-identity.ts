/** Stable idempotency key persisted with one generated worktree intent. */
export function createWorktreeRetryIdentity(): string {
  return globalThis.crypto.randomUUID();
}
