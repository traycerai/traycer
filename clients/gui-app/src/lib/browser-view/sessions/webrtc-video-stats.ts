/**
 * Maps a raw `RTCPeerConnection.getStats()` report to the wire's `videoStats`
 * shape (ticket 11). Pure and DOM-report-shaped only - no peer connection, no
 * timers - so it is testable against a fake `RTCStatsReport` built from a
 * plain `Map`.
 *
 * `glassToGlassMs` is deliberately not computed here: the only client-side
 * candidate (`requestVideoFrameCallback` metadata) times decode, not
 * capture-to-paint, so reporting it would be a fabricated number. The wire
 * field stays `null` until the host end can stamp a real capture timestamp
 * onto the frame for the client to diff against.
 */
import type { WebrtcVideoStatsFields } from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * The `videoStats` wire payload minus `glassToGlassMs` - this module never
 * has an honest number for it (see above), so it is not this type's to
 * carry; the caller (`video-plane-session.ts`) adds `glassToGlassMs: null`
 * when it builds the wire frame.
 */
export type WebrtcVideoStatsSample = Omit<
  WebrtcVideoStatsFields,
  "glassToGlassMs"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isInboundVideoRtp(value: Record<string, unknown>): boolean {
  return value.type === "inbound-rtp" && value.kind === "video";
}

/**
 * Only a fallback: after an ICE restart more than one candidate pair can
 * carry `nominated: true` (the retired pair from the old round, the new
 * winner), so a bare `nominated` scan can pick the wrong one and misreport
 * both `iceCandidatePairType` and `roundTripTimeMs`. The authoritative
 * answer is the `transport` stat's `selectedCandidatePairId`; this is only
 * consulted when no transport stat is present (older Chrome, or a synthetic
 * report in a test), narrowed further to `state === "succeeded"` so a
 * still-checking pair from a fresh restart cannot win over a genuinely
 * connected one either.
 */
function isFallbackNominatedCandidatePair(
  value: Record<string, unknown>,
): boolean {
  return (
    value.type === "candidate-pair" &&
    value.nominated === true &&
    value.state === "succeeded"
  );
}

function isTransportStat(value: Record<string, unknown>): boolean {
  return value.type === "transport";
}

function isCandidatePair(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly id: string } {
  return value.type === "candidate-pair" && typeof value.id === "string";
}

function isLocalCandidate(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly id: string } {
  return value.type === "local-candidate" && typeof value.id === "string";
}

interface CollectedStats {
  readonly inboundRtp: Record<string, unknown> | null;
  readonly selectedPair: Record<string, unknown> | null;
  readonly localCandidatesById: Map<string, Record<string, unknown>>;
}

/**
 * `RTCStatsReport` is a `ReadonlyMap<string, unknown>` keyed by stat id; each
 * value carries its own `type` discriminant. Walks it once, collecting every
 * candidate pair and local candidate by id, then resolves the selected pair
 * (`resolveSelectedPair`).
 */
function collectStats(report: RTCStatsReport): CollectedStats {
  let inboundRtp: Record<string, unknown> | null = null;
  let transport: Record<string, unknown> | null = null;
  let fallbackPair: Record<string, unknown> | null = null;
  const candidatePairsById = new Map<string, Record<string, unknown>>();
  const localCandidatesById = new Map<string, Record<string, unknown>>();

  for (const value of report.values()) {
    if (!isRecord(value)) continue;
    if (inboundRtp === null && isInboundVideoRtp(value)) {
      inboundRtp = value;
      continue;
    }
    if (transport === null && isTransportStat(value)) {
      transport = value;
      continue;
    }
    if (isCandidatePair(value)) {
      candidatePairsById.set(value.id, value);
      if (fallbackPair === null && isFallbackNominatedCandidatePair(value)) {
        fallbackPair = value;
      }
      continue;
    }
    if (isLocalCandidate(value)) {
      localCandidatesById.set(value.id, value);
    }
  }

  return {
    inboundRtp,
    selectedPair: resolveSelectedPair(
      transport,
      candidatePairsById,
      fallbackPair,
    ),
    localCandidatesById,
  };
}

/** Transport-authoritative, `fallbackPair` only when no transport stat resolves it. */
function resolveSelectedPair(
  transport: Record<string, unknown> | null,
  candidatePairsById: Map<string, Record<string, unknown>>,
  fallbackPair: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const selectedPairId = transport?.selectedCandidatePairId;
  if (typeof selectedPairId !== "string") return fallbackPair;
  return candidatePairsById.get(selectedPairId) ?? fallbackPair;
}

export function mapWebrtcVideoStats(
  report: RTCStatsReport,
): WebrtcVideoStatsSample | null {
  const { inboundRtp, selectedPair, localCandidatesById } =
    collectStats(report);
  if (inboundRtp === null) return null;

  const localCandidateId = selectedPair?.localCandidateId;
  const localCandidate =
    typeof localCandidateId === "string"
      ? localCandidatesById.get(localCandidateId)
      : undefined;
  const candidateType = localCandidate?.candidateType;

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
      numberField(selectedPair ?? {}, "currentRoundTripTime") * 1000,
    iceCandidatePairType:
      typeof candidateType === "string" ? candidateType : "unknown",
  };
}
