/**
 * Whether this HOST leaves the epic doc as a record source, per population.
 *
 * The cutover deletes the doc arm wherever the record plane covers the rows,
 * and this module is the one place that decides where that is. It lives beside
 * the store rather than under `runtime/` on purpose: the answer comes from the
 * negotiated-manifest registry, which is ambient main-thread module state, and
 * the runtime takes the answer as an injected getter so the worker relocation
 * has nothing to move.
 *
 * ## Why the two planes are asked different questions
 *
 * `epic.listChatRecords` and `epic.listTuiAgents` are both OFF
 * `RELEASED_FLOOR_METHOD_NAMES`, and that list is frozen - adding a name to it
 * is handshake-fatal against every released peer - so a released-floor host
 * answers `E_HOST_UNSUPPORTED` to both for as long as it is supported. On such
 * a host the doc is the only place its chats and terminal agents exist, and
 * deleting the arm would render the epic EMPTY rather than degraded. Hence:
 *
 *  - **Chats: presence is enough, at any minor.** `EpicChatRegistry.hydrate()`
 *    runs `hydrateLegacyDocSecondary` unconditionally, before any resolver
 *    executes, so a doc-only chat is served back as a `home: "doc"` registry
 *    row whether or not the `@1.1` remainder exists.
 *  - **Terminal agents: `@1.1` or nothing.** There is no hydration shim on that
 *    plane, and at `@1.0` the host deliberately WITHHOLDS doc-only entries
 *    because its contract says the caller still unions its own doc projection.
 *    So `@1.0` needs the doc arm exactly as much as an unsupported answer does.
 *
 * ## Fail-closed means the DOC stays on
 *
 * Every unknown answers "the doc is still a source". The two failure directions
 * are not symmetric: an arm left on where the record plane already covers the
 * rows merges two copies of the same id into one entry, while an arm switched
 * off where nothing covers them makes rows disappear from the tree, the sidebar
 * and every affordance keyed off them. One is a redundant merge; the other is
 * an epic that looks empty.
 *
 * The registry is self-correcting - a host upgraded in place re-handshakes on
 * its next RPC and overwrites its entry - so an unknown resolves rather than
 * latching, and both transports publish into it.
 *
 * **This whole module is Phase 5 material**, retired by the same support-horizon
 * decision that deletes the `@1` legacy adapters. It is retained code with a
 * named sunset, not an oversight: when the released floor no longer includes a
 * host that lacks these methods, both members become constant `false` and the
 * doc arms go with them.
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
 * The doc-arm verdict for `hostId`, read live.
 *
 * `null` host - a session with no host bound yet - answers "doc for both",
 * which is the same fail-closed direction as an unrecorded handshake.
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
  // `null` covers three cases the registry does not distinguish - the method is
  // absent, no handshake has completed, or only a legacy name-only recording
  // exists - and all three are "we cannot prove `@1.1`", which is the arm-on
  // answer.
  const tuiAgents =
    tuiVersion === null ||
    tuiVersion.major !== 1 ||
    tuiVersion.minor < TUI_AGENTS_REMAINDER_MINOR;
  if (!chats && !tuiAgents) return RECORD_PLANE_COVERS_BOTH;
  if (chats && tuiAgents) return DOC_IS_THE_ONLY_RECORD_SOURCE;
  return { chats, tuiAgents };
}
