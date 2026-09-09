import { useHostClient } from "@/lib/host";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { negotiatedSetPinnedServesLocalHome } from "@/lib/epic-pin-admission";

/**
 * Whether the host this surface would dispatch a pin to can pin a LOCAL-HOMED
 * epic — `epic.setPinned@1.1`.
 *
 * Reads `useHostClient()` deliberately, and the reason is the pairing rather
 * than the value: `useEpicSetPinned` dispatches on exactly that client, so the
 * manifest consulted here is the manifest of the process the request will
 * reach. Gating a control on one host's negotiation and sending the request to
 * another is the defect this hook exists not to have; a future host-scoped pin
 * surface must take its client as an argument rather than calling this.
 *
 * Every pin surface calls this — the desktop History row, the mobile tray and
 * the tab-strip context menu — so the three cannot drift into offering the
 * control on different rules.
 *
 * Fails closed through {@link negotiatedSetPinnedServesLocalHome}: `null`
 * (no handshake yet, no bound host) and `false` (the host does not advertise
 * the method) both read as unsupported, and the control enables itself on the
 * re-render when the manifest lands.
 */
export function useEpicPinLocalHomeSupported(): boolean {
  const client = useHostClient();
  const version = useHostNegotiatedMethodVersion(client, "epic.setPinned");
  return negotiatedSetPinnedServesLocalHome(version);
}
