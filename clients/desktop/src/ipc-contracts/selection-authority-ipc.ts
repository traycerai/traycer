/**
 * Desktop IPC binding for the selection-authority contract (D16). Revision 9,
 * settled by the P1.0 design review (nine rounds). The transport-agnostic core
 * lives in `@traycer-clients/shared/host-selection/selection-authority-contract`;
 * this module settles how it rides the runner-host IPC surface, following
 * the ownership-claim pattern (`electron-main/ipc/ownership-ipc.ts`,
 * `electron-preload/ownership-bridge.ts`).
 *
 * Channel names (P1.1 registers these in `ipc-channels.ts` - the one channel
 * module - alongside the handlers; recorded here as the settled contract,
 * not as a second registry; the eventual entries should be type-linked to
 * these maps):
 *
 *   sync    runnerHost:sync:selectionAttachSeq
 *   invoke  runnerHost:selection:attach
 *   invoke  runnerHost:selection:reportEvidence
 *   invoke  runnerHost:selection:activate
 *   invoke  runnerHost:selection:refreshFleet
 *   event   runnerHost:event:selection:selectionChanged
 *   event   runnerHost:event:selection:leasesChanged
 *   event   runnerHost:event:selection:reattachRequired
 *
 * Binding rules (what IPC adds on top of the core contract):
 *
 * - REPORTER IDENTITY comes from the IPC sender (`resolveSenderWindowId`),
 *   never from the payload. The binding calls `engine.reporterDetached` on
 *   webContents destruction AND on `render-process-gone`; soft replacement
 *   (reload, navigation, HMR re-mount) is covered by the attach claim.
 *   State mutates ONLY on a claim carrying the latest unconsumed seq
 *   (accepted, version-mismatched, or a parseable-seq malformed claim);
 *   `superseded` and seq-unparseable attempts are state-neutral.
 * - ATTACH-SEQ ALLOCATION is engine-side (core module header rule 1): at
 *   preload load the binding reads a fresh seq over the
 *   `selectionAttachSeq` SYNC channel (the pattern that serves `windowId`)
 *   - main resolves the sender window and calls
 *   `engine.allocateAttachSeq(reporterId)`. No preload-local counter
 *   exists, so a reloaded preload can never repeat or reset the sequence.
 * - INCARNATION SCOPING is client-instance scoped (core module header): the
 *   preload constructs ONE `SelectionAuthorityClient` instance per renderer
 *   load carrying that seq, and the instance holds the incarnation its own
 *   attach returned, stamping it into every `reportEvidence` / `activate`
 *   forward. A stale renderer generation holds a stale instance (stale
 *   seq, stale incarnation): its attach returns `superseded` and its late
 *   callbacks are dropped - the preload never stamps "the latest"
 *   incarnation on behalf of whoever calls.
 * - ATTACH is the guarded claim + session transfer (core module header
 *   rule 6). Main's handler choreography - pure parses first, then exactly
 *   one state-testing engine call: (1) `parseSelectionAttachSeq` on the
 *   raw payload - null → resolve `{ok: false, kind: "malformed-request",
 *   claimed: false}` without calling the engine (state-neutral); (2)
 *   `parseSelectionAttachRequest` - null →
 *   `engine.refuseMalformedAttach(reporterId, seq)` and resolve
 *   `{ok: false, kind: "malformed-request", claimed: <its boolean>}`
 *   (claimed=true: seq consumed, prior attachment retired, generation
 *   terminated); (3) otherwise `engine.attach(reporterId, request)` and
 *   resolve its result - the engine claims, retires, and installs the
 *   inventory in one transaction (no empty-session window). Main is
 *   single-threaded across parse and call, so nothing interleaves. Every
 *   `ok: false` completion obliges the client instance to dispose its
 *   listeners and buffer.
 * - ATTACH BUFFERING: the client instance registers its `ipcRenderer` event
 *   listeners and buffers deliveries, THEN invokes attach; on success it
 *   installs the snapshot, discards buffered events with `revision <=
 *   snapshot.revision`, replays the rest in revision order, and goes live.
 *   On failure (including `superseded` and an unparseable result) it
 *   disposes listeners and buffer. Event fan-out goes to every window
 *   unconditionally; a not-yet-attached window is buffering or disposed, so
 *   blind fan-out is harmless.
 * - VERSION: attach forwards the RENDERER bundle's compiled contract major
 *   (passed through the client API - the preload must not substitute its
 *   cached constant). A `version-mismatch` result is terminal for that
 *   renderer load and leaves the reporter fully detached engine-side.
 * - IDENTITY: the `reattachRequired` event - emitted only AFTER the
 *   engine's identity-transition transaction commits - is the MANDATORY
 *   re-attach trigger: the preload constructs a new client instance (fresh
 *   seq via the sync channel) and attaches. Re-attaching on the auth-
 *   session broadcast as well is permitted but not sufficient: an attach
 *   that races ahead of the transition is voided by it, and the
 *   `reattachRequired` that follows the commit is what guarantees the
 *   final post-transition attach.
 * - PARSER BOUNDARY: raw values cross in BOTH directions through the shared
 *   parsers - main runs `parseSelectionAttachSeq` then
 *   `parseSelectionAttachRequest` on the attach payload (the choreography
 *   above) and `parseSelectionEvidenceReport` on every inbound report
 *   (drop on null); the preload runs `parseRevisionedSelectionChange` /
 *   `parseRevisionedLeaseSnapshots` / `parseReattachRequired` on every
 *   event envelope and `parseSelectionAttachResult` /
 *   `parseActivateResult` on invoke results. Domain code on either side
 *   never sees unparsed input, so same-major skew safety is structural.
 * - `reportEvidence` rides invoke and resolves void; the preload contains
 *   rejections (catch + log) so a teardown-window race never surfaces as an
 *   unhandled rejection in the renderer.
 * - All payloads are structured-clone-safe plain data.
 */
import type {
  ActivateResult,
  HostLeaseSnapshot,
  SelectionAttachRequest,
  SelectionAttachResult,
  SelectionChange,
  SelectionEvidenceReport,
  SelectionReattachRequired,
  SelectionRevisioned,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";

/**
 * Sync-channel signatures (renderer/preload → main, `ipcRenderer.sendSync`
 * at preload load), keyed by channel suffix. `selectionAttachSeq` resolves
 * the sender window and returns `engine.allocateAttachSeq(reporterId)` -
 * allocation advances the supersession fence (core module header rule 4).
 */
export interface SelectionAuthoritySyncMap {
  selectionAttachSeq: {
    result: number;
  };
}

/**
 * Invoke-channel signatures (renderer → main), keyed by channel suffix.
 * `args` are the `ipcRenderer.invoke` arguments after the channel name;
 * `result` is what the main handler resolves. The `incarnationId` stamped by
 * the client instance travels as a leading argument on the two scoped calls.
 */
export interface SelectionAuthorityInvokeMap {
  attach: {
    /** ONE request object - the shape `parseSelectionAttachRequest` accepts. */
    args: [request: SelectionAttachRequest];
    result: SelectionAttachResult;
  };
  reportEvidence: {
    args: [incarnationId: string, report: SelectionEvidenceReport];
    result: void;
  };
  activate: {
    args: [incarnationId: string, hostId: string];
    result: ActivateResult;
  };
  /**
   * "The registry changed - re-read it" (P1.2 cold review F6).
   *
   * Main's fleet is refreshed on identity change, local-host change and
   * startup only, and the no-poller ruling stands: polling the registry from
   * main is what the audit's duplicated 60s pollers were. But a REMOTE
   * membership mutation happens in the renderer (a deregistration, a fresh
   * registration) and main has no way to hear about it, so deregistering the
   * preferred remote left main holding it as a live candidate, and a host
   * registered a moment ago was refused `unknown-host` by Activate's
   * directory validation.
   *
   * So the edge is EXPLICIT rather than periodic: the mutation that changed
   * membership says so. Unscoped and idempotent - it carries no membership of
   * its own, it only asks main to go and read, so a duplicate call costs one
   * fetch and a stale caller cannot assert anything false.
   */
  refreshFleet: {
    args: [];
    result: void;
  };
}

/**
 * Event-channel payloads (main → windows via `fanOut`), keyed by channel
 * suffix. THREE event kinds; every emission carries its own unique
 * authority revision (no two events ever share one), so a single
 * high-water mark per client totally orders all three.
 */
export interface SelectionAuthorityEventMap {
  selectionChanged: SelectionRevisioned<SelectionChange>;
  leasesChanged: SelectionRevisioned<readonly HostLeaseSnapshot[]>;
  /** Post-identity-transition re-attach trigger; see the IDENTITY rule. */
  reattachRequired: SelectionReattachRequired;
}
