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
  "following" | "connecting" | "unreachable" | "vanished" | "ready";

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

/** One host list's outcome, reduced to what the scope needs from it. */
export interface HostListOutcome {
  /** The query has produced data at least once. */
  readonly hasData: boolean;
  /** The query rejected. */
  readonly isError: boolean;
}

export interface HostListReadiness {
  /** Both lists have ANSWERED — with data or with an error. */
  readonly resolved: boolean;
  /** At least one list came back as an error. */
  readonly failed: boolean;
}

/**
 * Whether the two host lists have settled, and whether either failed doing it.
 *
 * A rejection is an ANSWER. Treating only data as settled left `resolved`
 * false forever on a failed request, so a pinned host that was genuinely gone
 * sat in `connecting` until the app restarted, and an empty union rendered the
 * confident "No hosts yet" — a definite claim produced by a question that
 * never came back. `failed` keeps those two apart so the empty state can say
 * which one it is and offer a retry instead of telling someone to install a
 * host they already own.
 *
 * Lives here, beside the status machine and away from the hook, for the same
 * reason `isHostScopeUsable` does: every panel suite mocks the hook wholesale,
 * so a rule that lives inside it is a rule no test can reach.
 */
export function hostListReadiness(
  directory: HostListOutcome,
  registry: HostListOutcome,
): HostListReadiness {
  return {
    resolved:
      (directory.hasData || directory.isError) &&
      (registry.hasData || registry.isError),
    failed: directory.isError || registry.isError,
  };
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
  // No host AND no answer yet from the lists is the one genuine pending state
  // this surface has: a cold Settings before either source has replied.
  // (`isFollowing` implies a host, so this order changes nothing for it.)
  if (input.host === null) {
    return input.listsResolved ? "unreachable" : "connecting";
  }
  // No route exists and none is being built — this is terminal, not pending,
  // and must not render as a spinner that never resolves.
  //
  // This is asked BEFORE `following` on purpose. `following` is a claim about
  // the CLIENT — "the ambient one is the right one to read through" — not about
  // the pick, and it stops being true the moment the active host's entry goes
  // `unavailable` while keeping its id. Answering `following` first let exactly
  // that case bypass the availability rule the model had just been fixed to
  // enforce: `connectable` was correctly false, and the active host alone
  // ignored it, mounting RPC panels on a route the transport refuses.
  if (!input.host.connectable) return "unreachable";
  if (input.isFollowing) return "following";
  if (input.overrideClient !== null) return "ready";
  // Connectable, but no client. The transient client is built SYNCHRONOUSLY
  // (`createRequester` is a Proxy), so the only way to get here is a missing
  // request context or unbound user: signed out. Terminal until sign-in.
  return input.hasRequestAuthority ? "connecting" : "unreachable";
}
