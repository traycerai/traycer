/**
 * Placeholder hostId used by renderer code that needs to construct an artifact (chat, terminal, tui-agent) before a real host binding has been resolved - for example, in error/loading states or when a host provider has not produced an active id yet, and on.
 */
export const UNKNOWN_HOST_PLACEHOLDER = "__no-host__";

export function isUnknownHost(id: string): boolean {
  return id === UNKNOWN_HOST_PLACEHOLDER;
}
