/**
 * Docs: see ../../SETTINGS.md (Permissions).
 * Update that file whenever this settings surface changes.
 */
import { Fragment, type ReactNode } from "react";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * The read a tab body is mounted on. Each tab asks about its OWN method:
 * `autoJudge.get` and `autoPolicy.get` are negotiated independently, so one
 * answering is not evidence about the other, and `autoJudge.listRecent` is a
 * later method still.
 */
type AutoModeTabMethod =
  | "autoJudge.get"
  | "autoPolicy.get"
  | "autoJudge.listRecent";

/**
 * What the Judge, Rules and Activity tabs sit behind INSIDE `HostScopeGate`:
 * the scoped host's binding, the capability verdict for the tab's own read,
 * and the key that discards a tab's state when the viewer or the host changes.
 *
 * `HostScopeGate` owns the copy for a scope that is connecting, unreachable or
 * vanished; this still checks `isHostScopeUsable` itself so a body is not
 * MOUNTED under a dead scope - the gate hides its children in an `<Activity>`,
 * and a hidden-but-mounted query is still the wrong host's query.
 *
 * **Tri-state, deliberately.** `null` ("no handshake with this host yet") is
 * not `false` ("this host handshook and lacks the method"), and the
 * difference matters here: the unsupported verdict parks every RPC the tab
 * owns, and those RPCs are what would produce the handshake that overturns
 * it. So while the verdict is unknown the tab says nothing, and the probe
 * below keeps a `false` refutable - one bounded read of a released-floor
 * method, re-asked when the host's version or dialability changes, issued
 * exactly while the tab is parked. `scope.client`, never the ambient one, so it
 * asks the host this page is showing.
 *
 * **Keyed by VIEWER and host**, and both halves are load-bearing. A draft or
 * an in-flight pick must never carry across a host switch; and the policy
 * query is partitioned by viewer, but partitioning the cache does nothing
 * about an editor already mounted - switching from account A to B on a host
 * that stays usable, with B's policy cached, would leave A's draft on screen
 * with B's mutation behind Save. A remount discards the outgoing state whole.
 * `JSON.stringify` rather than a joined string: host ids carry `:`, and a
 * two-element array leaves nothing to reason about.
 */
export function AutoModeHostGate(props: {
  readonly method: AutoModeTabMethod;
  /** The one sentence for a host that answered and lacks `method`. */
  readonly unsupported: ReactNode;
  readonly children: (hostId: string | null) => ReactNode;
}): ReactNode {
  const scope = useHostScope();
  const realBinding = useHostBinding();
  const scopedBinding = useScopedHostBinding(scope);
  const support = useHostMethodSupport(scope.hostId, props.method);
  const viewerUserId = useCloudChatViewerId();
  useHostCapabilityProbe({
    client: scope.client,
    stale: support !== true,
    incarnation: [
      scope.host?.version ?? null,
      scope.host?.connectable ?? false,
    ],
  });

  if (!isHostScopeUsable(scope.status)) return null;
  const binding = scopedBinding ?? realBinding;
  // "Not known yet" is not "unsupported": the same fail-toward-silence the
  // composer's disclosure takes, and the reason the tri-state exists.
  if (support === null && binding !== null) return null;
  if (support !== true || binding === null) return props.unsupported;
  return (
    <HostRuntimeContext.Provider value={binding}>
      <Fragment key={JSON.stringify([viewerUserId, scope.hostId])}>
        {props.children(scope.hostId)}
      </Fragment>
    </HostRuntimeContext.Provider>
  );
}

/** The line a gated tab shows on a host whose Auto mode is too old. */
export function AutoModeUnsupportedLine(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      className="px-1 text-ui-sm text-muted-foreground"
      data-testid="auto-mode-unsupported"
    >
      {props.children}
    </p>
  );
}
