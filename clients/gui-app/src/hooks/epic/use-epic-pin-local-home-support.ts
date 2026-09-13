import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { negotiatedSetPinnedServesLocalHome } from "@/lib/epic-pin-admission";

/**
 * Whether the host this surface would dispatch a pin to can pin a LOCAL-HOMED
 * epic — `epic.setPinned@1.1`.
 *
 * `hostId` must be the host the pin will be DISPATCHED to, which is the host
 * the row's own reading named, or `null` to follow the window. The pairing is
 * the whole point of the hook rather than the value: `useEpicSetPinned`
 * resolves its client from `variables.hostId` the same way, so the manifest
 * consulted here is the manifest of the process the request will reach. Gating
 * a control on one host's negotiation and sending the request to another is the
 * defect this hook exists not to have.
 *
 * This hook USED TO READ `useHostClient()` with no argument, and its own
 * comment said that was safe BECAUSE the mutation dispatched on exactly that
 * client — then the mutation started resolving the epic's own host per
 * dispatch, and the premise was gone while the prose still asserted it. What
 * the asymmetry produced is worth naming, because it is not a type error and no
 * test of either half alone sees it: for a local-homed epic on a host that has
 * NOT negotiated `@1.1`, in a window whose own host HAS, the menu item rendered
 * enabled (this gate said yes) and the click did nothing at all (the dispatch
 * gate said no) — a control that fires and does nothing, which is the failure
 * `epicPinDispatchAdmitted` is documented as existing to prevent.
 *
 * Every pin surface calls this — the desktop History row, the mobile tray and
 * the tab-strip context menu — so the three cannot drift into offering the
 * control on different rules. The two History surfaces pass `null` and are
 * right to: their local-home readings come from `useEpicGetTaskContexts`, which
 * queries the WINDOW's host on a single client, so the host that reported a row
 * local-homed is the host `null` resolves to. The tab strip passes a host
 * because its readings span one per open tab's session.
 *
 * Fails closed through {@link negotiatedSetPinnedServesLocalHome}: `null`
 * (no handshake yet, no bound host) and `false` (the host does not advertise
 * the method) both read as unsupported, and the control enables itself on the
 * re-render when the manifest lands.
 */
export function useEpicPinLocalHomeSupported(hostId: string | null): boolean {
  // The `null` arm falls back to the following client, which is exactly what
  // `useEpicSetPinned` does for a row that names no host.
  const client = useHostClientForHostId(hostId);
  const version = useHostNegotiatedMethodVersion(client, "epic.setPinned");
  return negotiatedSetPinnedServesLocalHome(version);
}
