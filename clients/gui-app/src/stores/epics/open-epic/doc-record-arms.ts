/**
 * Unknown answers keep the doc arm on; switching it off where nothing covers
 * the rows empties the epic. Chats: any presence. Terminal agents: @1.1 or nothing.
 */
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EpicDocRecordArms } from "./projection-helpers";
import {
  DOC_IS_THE_ONLY_RECORD_SOURCE,
  RECORD_PLANE_COVERS_BOTH,
} from "./projection-helpers";

/** The minor of `epic.listTuiAgents` that first serves the doc remainder. */
const TUI_AGENTS_REMAINDER_MINOR = 1;

/**
 * The doc-arm verdict for `hostId`, read live. `null` host - a session with no host bound yet -
 * answers "doc for both", which is the same fail-closed direction as an unrecorded handshake.
 */
export function readEpicDocRecordArms(
  hostId: string | null,
): EpicDocRecordArms {
  if (hostId === null) return DOC_IS_THE_ONLY_RECORD_SOURCE;
  const methods = getNegotiatedHostMethods(hostId);
  if (methods === null) return DOC_IS_THE_ONLY_RECORD_SOURCE;
  const chats = !methods.has("epic.listChatRecords");
  const tuiVersion = getNegotiatedHostMethodVersion(
    hostId,
    "epic.listTuiAgents",
  );
  // `null` covers three cases the registry does not distinguish - the method is absent, no handshake
  // has completed, or only a legacy name-only recording exists - and all three are "we cannot prove
  const tuiAgents =
    tuiVersion === null ||
    tuiVersion.major !== 1 ||
    tuiVersion.minor < TUI_AGENTS_REMAINDER_MINOR;
  if (!chats && !tuiAgents) return RECORD_PLANE_COVERS_BOTH;
  if (chats && tuiAgents) return DOC_IS_THE_ONLY_RECORD_SOURCE;
  return { chats, tuiAgents };
}
