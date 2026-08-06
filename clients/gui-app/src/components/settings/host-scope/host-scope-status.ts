import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/**
 * Whether the host a panel is showing is the host its client actually talks to.
 *
 * These five are the whole safety contract of this surface, and they exist
 * because three of them look identical if you only check `client !== null`:
 *
 *   - `following` — no explicit pick; the panel is scoped to the active host.
 *     Its client IS the ambient one, so reading through it is correct.
 *   - `connecting` — genuinely pending: the host lists have not both answered
 *     yet. `client` is `null`. Callers must NOT fall back to the ambient
 *     client: doing so shows host A's data under host B's name.
 *   - `unreachable` — terminal. The picked host exists but this client has no
 *     route to it (registry-only row, a directory entry with no websocket URL,
 *     or no credential to build a requester with). Never a spinner.
 *   - `vanished` — the picked host left the directory entirely: deregistered,
 *     or signed out from. `host` is `null` and the caller must say so and
 *     offer a way back. It deliberately does NOT auto-reset to the active
 *     host: silently re-pointing an administration surface at a different
 *     machine is the precise failure this whole redesign exists to remove, and
 *     it is worst here — the moment a destructive dialog is open.
 *   - `ready` — the picked host resolved to a live client of its own.
 *
 * The invariant every consumer owes: **a visible host name must always match
 * the client used by every read, stream and mutation beneath it.** When that
 * cannot be proven, render loading or unavailable — never somebody else's data.
 *
 * WHY THIS FILE EXISTS, separately from `use-host-scope.ts`: every panel suite
 * mocks that module wholesale, and each one stubbed `isHostScopeUsable: () =>
 * true`. A predicate a test always replaces is a predicate no test covers — so
 * the stub answered "usable" for states that are not, and the panels' real
 * behaviour in those states went unexercised. This module holds no hooks, so
 * nothing needs to mock it, and the real predicate runs in every suite.
 */
export type HostScopeStatus =
  | "following"
  | "connecting"
  | "unreachable"
  | "vanished"
  | "ready";

/**
 * True when the scope resolved to a client the caller may read/write through.
 *
 * The gate decides what is RENDERED; this decides what is MOUNTED, and the
 * difference is the whole point. A query hook mounted under a non-ready scope
 * still fires against the ambient host and caches its answer, no matter that
 * the gate hides the result — so panels that own host reads check this before
 * mounting them, and use the gate for the copy.
 */
export function isHostScopeUsable(status: HostScopeStatus): boolean {
  return status === "following" || status === "ready";
}

/**
 * The status derivation. Exported for its own tests: every "which client may
 * this panel use" decision reduces to this return value, and panel suites mock
 * the whole scope, so nothing else exercises it.
 */
export function deriveHostScopeStatus(input: {
  readonly isFollowing: boolean;
  readonly host: HostScopeOption | null;
  readonly vanishedHostId: string | null;
  readonly overrideClient: HostClient<HostRpcRegistry> | null;
  readonly hasRequestAuthority: boolean;
  readonly listsResolved: boolean;
}): HostScopeStatus {
  if (input.vanishedHostId !== null) return "vanished";
  if (input.isFollowing) return "following";
  // No host AND no answer yet from the lists is the one genuine pending state
  // this surface has: a cold Settings before either source has replied.
  if (input.host === null) {
    return input.listsResolved ? "unreachable" : "connecting";
  }
  // No route exists and none is being built — this is terminal, not pending,
  // and must not render as a spinner that never resolves.
  if (!input.host.connectable) return "unreachable";
  if (input.overrideClient !== null) return "ready";
  // Connectable, but no client. The transient client is built SYNCHRONOUSLY
  // (`createRequester` is a Proxy), so the only way to get here is a missing
  // request context or unbound user: signed out. Terminal until sign-in.
  return input.hasRequestAuthority ? "connecting" : "unreachable";
}
