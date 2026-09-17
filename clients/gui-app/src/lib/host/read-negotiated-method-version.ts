import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * The three states a negotiated-version read can be in, for ONE host.
 *
 * - `null` - no client/bound host, no handshake has completed yet, or the
 *   method is present but its canonical version was not recorded. Nothing is
 *   known about whether the method meets a version gate.
 * - `false` - the host completed a handshake and did not advertise the method.
 * - a `{ major, minor }` version - the host advertised it at that version.
 */
export type NegotiatedMethodVersion = SchemaVersion | false | null;

/**
 * The registry read, in the three states above. The registry's own version
 * getter returns `null` for both "unknown" and "absent"; composing it with the
 * stable method set separates known absence. A name-only legacy record leaves
 * a present method's version unknown, which remains `null`, and every consumer
 * shares this one composition rather than re-deriving it.
 *
 * Lives in `lib/` rather than beside the hook that subscribes to it because
 * it is also a DISPATCH-time read: a callback a surface holds across a
 * re-negotiation (History's `refetch`), and the fetcher's post-wait dispatch
 * boundary, must re-derive the gate from the live registry rather than trust
 * the version a render captured - and a fetcher is not a hook.
 */
export function readNegotiatedMethodVersion(
  hostId: string,
  method: string,
): NegotiatedMethodVersion {
  const methods = getNegotiatedHostMethods(hostId);
  if (methods === null) return null;
  if (!methods.has(method)) return false;
  return getNegotiatedHostMethodVersion(hostId, method);
}
