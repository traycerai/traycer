/**
 * Docs: see ../../SETTINGS.md (Permissions).
 * Update that file whenever this settings surface changes.
 */
import { Fragment, useState, type ReactNode } from "react";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
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
 * vanished. **A body is never unmounted because the scope stopped being
 * usable.** The Rules tab is an always-open editor, and a host restart, a sleep
 * or a relay blip would otherwise throw away unsaved text and drafts already
 * taken from a card. While the scope cannot serve, the body keeps rendering
 * against the LAST usable binding: `HostScopeGate` holds it in a hidden
 * `<Activity>`, which tears its effects and subscriptions down, so nothing
 * issues a read against a host that is not there, and its host-keyed
 * `<Activity>` still discards the body on a real switch of machine. What stays
 * true is the other half: a body is never FIRST mounted under a scope that is
 * not usable, so no read ever starts against the wrong host.
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
 * **Keyed by VIEWER and host**, and both halves are load-bearing. An in-flight
 * judge pick must never carry across a host switch - the judge is the
 * machine's - and a body's reads and mutations are the host's. The Rules EDIT
 * does carry across one, deliberately: the policy is the account's, so the
 * page holds the edit and the remounted editor resumes it (`useRulesEdit`).
 * The viewer half: the policy query is partitioned by viewer, but partitioning
 * the cache does nothing about an editor already mounted - switching from
 * account A to B on a host that stays usable, with B's policy cached, would
 * leave A's draft on screen with B's mutation behind Save. A remount discards
 * the outgoing state whole, and the page drops A's edit with it.
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

  const usable = isHostScopeUsable(scope.status);
  const binding = scopedBinding ?? realBinding;
  const held = useHeldBinding(
    usable && support === true && binding !== null
      ? { scopeHostId: scope.hostId, binding }
      : null,
  );
  const shown = gatedBinding({
    hostId: scope.hostId,
    usable,
    support,
    binding,
    held,
  });
  if (shown === "unsupported") return props.unsupported;
  if (shown === null) return null;
  return (
    <HostRuntimeContext.Provider value={shown}>
      <Fragment key={JSON.stringify([viewerUserId, scope.hostId])}>
        {props.children(scope.hostId)}
      </Fragment>
    </HostRuntimeContext.Provider>
  );
}

type GateBinding = HostRuntimeBinding<HostRpcRegistry>;

/**
 * A binding the body was rendered against, and the machine the SCOPE named
 * when it was. The binding's own `hostId` cannot say which machine that was:
 * a `following` binding names no host (`hostId: null`) by design, so the
 * subtree tracks the effective host - and `following` is the default.
 */
interface HeldBinding {
  readonly scopeHostId: string | null;
  readonly binding: GateBinding;
}

/**
 * The binding the body was last rendered against, held so a scope that stops
 * serving does not unmount it. State adjusted during render rather than a ref,
 * because the body is rendered from it; compared member by member, so a
 * binding rebuilt from the same parts settles instead of re-rendering.
 */
function useHeldBinding(live: HeldBinding | null): HeldBinding | null {
  const [held, setHeld] = useState(live);
  if (live !== null && (held === null || !sameHeld(live, held))) {
    setHeld(live);
  }
  return live ?? held;
}

function sameHeld(a: HeldBinding, b: HeldBinding): boolean {
  return a.scopeHostId === b.scopeHostId && sameBinding(a.binding, b.binding);
}

function sameBinding(a: GateBinding, b: GateBinding): boolean {
  return (
    a.hostId === b.hostId &&
    a.hostClient === b.hostClient &&
    a.runtime === b.runtime &&
    a.directory === b.directory &&
    a.auth === b.auth
  );
}

/**
 * What the gate renders: the live binding, the held one, the unsupported line,
 * or nothing.
 */
function gatedBinding(input: {
  readonly hostId: string | null;
  readonly usable: boolean;
  readonly support: boolean | null;
  readonly binding: GateBinding | null;
  readonly held: HeldBinding | null;
}): GateBinding | "unsupported" | null {
  // Held only for the machine it served, so no body ever renders on another
  // machine's binding, whatever keys the gates around this one. Compared by
  // the scope's host, never the binding's: see `HeldBinding`.
  const held =
    input.held !== null && input.held.scopeHostId === input.hostId
      ? input.held.binding
      : null;
  // A scope that cannot serve keeps whatever was already mounted; with nothing
  // mounted yet, nothing mounts.
  if (!input.usable) return held;
  // "Not known yet" is not "unsupported": the same fail-toward-silence the
  // composer's disclosure takes, and the reason the tri-state exists. A body
  // already on screen stays there while a re-handshake answers again.
  if (input.support === null && input.binding !== null) return held;
  if (input.support !== true || input.binding === null) return "unsupported";
  return input.binding;
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
