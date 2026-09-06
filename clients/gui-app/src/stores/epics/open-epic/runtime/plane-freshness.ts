/**
 * How each plane answers `ClassFreshness`, and what the `@1` line can honestly
 * say.
 *
 * Per class, never blended: there is deliberately no helper here that folds
 * three planes into one verdict. An aggregate `synced` boolean hides per-class
 * staleness - a live control lane with a three-minute-old record lane reads as
 * "synced" - and, worse, hides rejected writes.
 *
 * ## What `@1` cannot say
 *
 * `watermark` is always `null` and `trust` is always `null` on this line, and
 * both are honest rather than unimplemented. `epic.subscribe@1` has no
 * `(authorityEpoch, lane, position)` cursor - its resume is a Yjs state vector,
 * which is a different coordinate system and not orderable as a position - and
 * it carries no seed-vs-reconciled marker, so a legacy adapter genuinely cannot
 * report either. Filling them in with a synthesised value would make a claim the
 * wire never made; `null` for trust is "not applicable", and a caller gating a
 * privileged action must treat it exactly as `"seed-only"`.
 */
import type {
  ClassFreshness,
  PlaneId,
  ReplicaDataClass,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicSessionFacts } from "./session-facts";

export function deriveClassFreshness(args: {
  readonly planeId: PlaneId;
  readonly dataClass: ReplicaDataClass;
  readonly session: EpicSessionFacts;
  /** When this plane last applied a frame, or `null` before its first. */
  readonly observedAtMs: number | null;
}): ClassFreshness {
  const { planeId, dataClass, session, observedAtMs } = args;
  const degradedReason = session.degradedReason();
  if (degradedReason !== null) {
    return {
      planeId,
      dataClass,
      status: "degraded",
      watermark: null,
      observedAtMs,
      trust: null,
      degradedReason,
    };
  }
  // Pre-observation silence means UNKNOWN, never clean and never stale - a UI
  // that renders "unknown" as either is asserting something no frame has said.
  let status: ClassFreshness["status"];
  if (observedAtMs === null) {
    status = "unknown";
  } else if (session.transportStatus() === "open") {
    status = "live";
  } else {
    status = "stale";
  }
  return {
    planeId,
    dataClass,
    status,
    watermark: null,
    observedAtMs,
    trust: null,
    degradedReason: null,
  };
}
