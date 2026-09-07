/**
 * Adapter selection is per connection, not per session.
 * Unknown is not a selection; fingerprint the chosen arm, not the raw manifest.
 */
import type {
  AdapterSelection,
  LaneAdapter,
} from "@traycer-clients/shared/replica-runtime";
import {
  EPIC_LANE_METHODS,
  hostServesEpicLanes,
} from "@traycer-clients/shared/epic-lanes";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";

/**
 * Which arm serves this connection. A closed two-member union rather than a boolean, so the value
 * that reaches a log, a fingerprint and a test reads as the decision it is.
 */
export type EpicAdapterArm = "legacy" | "lanes";

/**
 * What the negotiated manifest says, including the honest third answer. `"undecided"` is NOT a
 * degraded `"legacy"`.
 */
export type EpicAdapterVerdict = EpicAdapterArm | "undecided";

/** Whether an arm can carry ROOT-document writes to its authority. Only `@1` can. */
export function armCarriesRootWrites(arm: EpicAdapterArm | null): boolean {
  return arm === "legacy";
}

/** Reads this connection's negotiated support for one stream method. */
export type EpicMethodSupportReader = (method: string) => StreamMethodSupport;

/** The manifest's verdict for this connection. */
export function readEpicAdapterVerdict(
  support: EpicMethodSupportReader,
): EpicAdapterVerdict {
  if (hostServesEpicLanes(support)) return "lanes";
  const refused = EPIC_LANE_METHODS.some(
    (method) => support(method) === "unsupported",
  );
  return refused ? "legacy" : "undecided";
}

/** Fold a verdict into the arm currently installed. */
export function settleEpicAdapterArm(
  installed: EpicAdapterArm | null,
  verdict: EpicAdapterVerdict,
): EpicAdapterArm | null {
  return verdict === "undecided" ? installed : verdict;
}

/**
 * The digest the runtime compares across reconnects. See the module doc for why this is a function
 * of the arm and not of the three support values.
 */
export function epicAdapterFingerprint(arm: EpicAdapterArm): string {
  return `epic-adapters:${arm}`;
}

/**
 * Assemble the seam's {@link AdapterSelection} from the arm and the adapters actually built for
 * it.
 */
export function epicAdapterSelection<TEvent>(
  arm: EpicAdapterArm,
  adapters: readonly LaneAdapter<TEvent>[],
): AdapterSelection {
  return {
    descriptors: adapters.map((adapter) => adapter.descriptor),
    fingerprint: epicAdapterFingerprint(arm),
  };
}
