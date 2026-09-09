/**
 * Maps a raw `RTCPeerConnection.getStats()` report to the getStats-derived half
 * of the wire's `videoStats` shape (ticket 11). Pure and DOM-report-shaped only
 * - no peer connection, no timers - so it is testable against a fake
 * `RTCStatsReport` built from a plain `Map`.
 *
 * The timing half of the payload does not come from `getStats()` at all:
 * glass-to-glass and its two legs are read off `requestVideoFrameCallback`
 * metadata (`video-frame-latency.ts`) and the DataChannel RTT off a `ping`, so
 * both are the session's to add (`video-plane-session.ts`) rather than this
 * mapper's to invent.
 */
import { browserScreencastIcePairTypeSchema } from "@traycer/protocol/host/browser/contracts";
import type { WebrtcVideoStatsSample } from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * The subset `getStats()` alone can answer; see the module comment. The full
 * payload is `WebrtcVideoStatsSample`, defined with the rest of the wire shape
 * in `webrtc-media-registry.ts`.
 */
type WebrtcVideoStatsReportFields = Omit<
  WebrtcVideoStatsSample,
  | "glassToGlassMs"
  | "glassToGlassP95Ms"
  | "networkPlusJitterMs"
  | "decodeCompositeMs"
  | "dataChannelRttMs"
>;

/** One `RTCStatsReport` entry: an untyped bag carrying its own `type` discriminant. */
type StatRecord = Record<string, unknown>;

function isStatRecord(value: unknown): value is StatRecord {
  return typeof value === "object" && value !== null;
}

function numberField(record: StatRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inboundVideoRtp(report: RTCStatsReport): StatRecord | null {
  for (const value of report.values()) {
    if (!isStatRecord(value)) continue;
    if (value.type === "inbound-rtp" && value.kind === "video") return value;
  }
  return null;
}

/**
 * The inbound video RTP stat's jitter, in milliseconds - `null` when the report
 * carries none yet (pre-first-sample). Read by the registry's adaptive
 * jitter-buffer tuning, which needs this one field and not the whole shape.
 */
export function inboundVideoJitterMs(report: RTCStatsReport): number | null {
  const jitter = inboundVideoRtp(report)?.jitter;
  return typeof jitter === "number" ? jitter * 1000 : null;
}

/** The stat entries `mapWebrtcVideoStats` needs, indexed in one pass. */
interface CollectedStats {
  transport: StatRecord | null;
  /**
   * Only consulted when no `transport` stat names the selected pair (older
   * Chrome, or a synthetic report in a test): after an ICE restart more than
   * one pair can carry `nominated: true`, so `state === "succeeded"` narrows
   * it further - a still-checking pair from a fresh restart must not win over
   * a genuinely connected one.
   */
  nominatedPair: StatRecord | null;
  inboundRtp: StatRecord | null;
  readonly candidatePairsById: Map<string, StatRecord>;
  readonly localCandidatesById: Map<string, StatRecord>;
}

function collectStats(report: RTCStatsReport): CollectedStats {
  const collected: CollectedStats = {
    transport: null,
    nominatedPair: null,
    inboundRtp: null,
    candidatePairsById: new Map<string, StatRecord>(),
    localCandidatesById: new Map<string, StatRecord>(),
  };
  const { candidatePairsById, localCandidatesById } = collected;

  for (const value of report.values()) {
    if (!isStatRecord(value)) continue;
    const id = typeof value.id === "string" ? value.id : null;
    if (value.type === "inbound-rtp" && value.kind === "video") {
      collected.inboundRtp ??= value;
    } else if (value.type === "transport") {
      collected.transport ??= value;
    } else if (value.type === "candidate-pair" && id !== null) {
      candidatePairsById.set(id, value);
      if (
        collected.nominatedPair === null &&
        value.nominated === true &&
        value.state === "succeeded"
      ) {
        collected.nominatedPair = value;
      }
    } else if (value.type === "local-candidate" && id !== null) {
      localCandidatesById.set(id, value);
    }
  }
  return collected;
}

export function mapWebrtcVideoStats(
  report: RTCStatsReport,
): WebrtcVideoStatsReportFields | null {
  const {
    transport,
    nominatedPair,
    inboundRtp,
    candidatePairsById,
    localCandidatesById,
  } = collectStats(report);
  if (inboundRtp === null) return null;

  const selectedPairId = transport?.selectedCandidatePairId;
  const selectedPair =
    (typeof selectedPairId === "string"
      ? candidatePairsById.get(selectedPairId)
      : undefined) ?? nominatedPair;
  const localCandidateId = selectedPair?.localCandidateId;
  const localCandidate =
    typeof localCandidateId === "string"
      ? localCandidatesById.get(localCandidateId)
      : undefined;

  return {
    framesDecoded: numberField(inboundRtp, "framesDecoded"),
    framesDropped: numberField(inboundRtp, "framesDropped"),
    // Spec-signed (duplicate/late packets go negative) - routine on a lossy
    // path - but the wire field is nonnegative, so a raw negative would fail
    // the resolver's parse every cadence tick. Clamped here, not upstream:
    // the mapper is the seam between "what the DOM reports" and "what the
    // wire contract promises".
    packetsLost: Math.max(0, numberField(inboundRtp, "packetsLost")),
    jitterMs: numberField(inboundRtp, "jitter") * 1000,
    roundTripTimeMs:
      selectedPair === null
        ? 0
        : numberField(selectedPair, "currentRoundTripTime") * 1000,
    // The wire vocabulary is closed; anything else the DOM reports is "unknown".
    iceCandidatePairType: browserScreencastIcePairTypeSchema
      .catch("unknown")
      .parse(localCandidate?.candidateType),
  };
}
