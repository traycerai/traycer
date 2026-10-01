/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Ports).
 * Update that file whenever this settings surface changes.
 */
import type {
  HeldPortForwardLease,
  OwnedPortForward,
  PortForwardListForHostResponse,
} from "@traycer/protocol/host/port-forward";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { usePortForwardListFor } from "@/hooks/port-forward/use-port-forward-list-for-query";

/*
 * Overview ▸ Ports' one read of its host's port lists, and what it resolves
 * to. The panel owns the read so the tab body and the count on the tab's
 * trigger are one answer; this module holds no component, so the tab and the
 * card keep Fast Refresh.
 */

/**
 * What the Ports tab shows, decided in this order: a host still connecting
 * (or restarting) has no answer to wait on yet, an unreachable one has none to
 * give, a host too old for port forwarding cannot be asked, and only then does
 * the read itself - pending, failed, or listed - decide.
 */
export type HostPortForwardsView =
  | { readonly kind: "connecting" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "listed";
      readonly owned: readonly OwnedPortForward[];
      readonly held: readonly HeldPortForwardLease[];
    };

export interface HostPortForwards {
  readonly view: HostPortForwardsView;
  /**
   * Owned forwards plus held ports, for the tab's trigger - `null` when there
   * are none, and whenever the view is not a list: a host too old for port
   * forwarding, and a list that cannot be read right now, carry no count.
   */
  readonly count: number | null;
  /** A read is in flight: Refresh shows its spinner and waits. */
  readonly fetching: boolean;
  /** Re-reads the lists now, on top of the 15-second cadence. */
  readonly refresh: () => void;
}

export function resolveHostPortForwardsView(input: {
  /** The scope is connecting, or the host is restarting. */
  readonly connecting: boolean;
  readonly usable: boolean;
  /** `portForward.listForHost` in the handshake; `null` before one. */
  readonly supported: boolean | null;
  readonly data: PortForwardListForHostResponse | undefined;
  /** The last settled read failed. */
  readonly readFailed: boolean;
}): HostPortForwardsView {
  if (input.connecting) return { kind: "connecting" };
  if (!input.usable) return { kind: "unreachable" };
  if (input.supported === false) return { kind: "unsupported" };
  // Before the latest answer, not beside it: rows a failed re-read left in the
  // cache are no longer the host's list, and a count taken from them would
  // stop tracking it.
  if (input.readFailed) return { kind: "unreadable" };
  if (input.data === undefined) return { kind: "loading" };
  return { kind: "listed", owned: input.data.owned, held: input.data.held };
}

export function countHostPortForwards(
  view: HostPortForwardsView,
): number | null {
  if (view.kind !== "listed") return null;
  const count = view.owned.length + view.held.length;
  return count === 0 ? null : count;
}

/**
 * The Overview's read of `portForward.listForHost`, polled on the method's
 * 15-second table cadence while the page is open and the window is visible.
 *
 * Today's gates hold: nothing is read while the scope cannot reach the host,
 * or from a host whose handshake lacks the method (the method is optional, so
 * an older host negotiates it away, and "no handshake yet" is not a yes).
 */
export function useHostPortForwards(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly usable: boolean;
  readonly connecting: boolean;
}): HostPortForwards {
  const supported = useHostMethodSupport(
    input.hostId,
    "portForward.listForHost",
  );
  const list = usePortForwardListFor(
    input.client,
    input.usable && supported === true,
    true,
  );
  const view = resolveHostPortForwardsView({
    connecting: input.connecting,
    usable: input.usable,
    supported,
    data: list.data,
    // `isError` alone would clear the moment a retry starts from a failure
    // with nothing cached (TanStack returns that query to `pending`), and the
    // failure line would give way to the loading shape under the reader's
    // own Refresh. `errorUpdateCount` is the settle counter nothing resets.
    readFailed:
      list.isError || (list.data === undefined && list.errorUpdateCount > 0),
  });
  return {
    view,
    count: countHostPortForwards(view),
    fetching: list.isFetching,
    refresh: () => {
      void list.refetch();
    },
  };
}
