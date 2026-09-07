/**
 * How each plane answers `ClassFreshness`, and what the `@1` line can honestly say. Per class,
 * never blended: there is deliberately no helper here that folds three planes into one verdict.
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
