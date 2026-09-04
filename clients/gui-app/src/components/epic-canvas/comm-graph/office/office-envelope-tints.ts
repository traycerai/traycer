import type { CommGraphPulseKind } from "@/lib/comm-graph/comm-graph-timeline";

/**
 * Envelope tints per pulse kind.
 *
 * Fixed hex rather than theme tokens: an envelope is a colored object in a
 * scene, and the four kinds have to stay distinguishable from each other on
 * both floors. Shared with the legend, which is the only place the colors are
 * ever named in words - so the key and the floor cannot drift apart.
 */
export const OFFICE_ENVELOPE_TINTS: Readonly<
  Record<CommGraphPulseKind, string>
> = {
  request: "#3b82f6",
  reply: "#22c55e",
  notice: "#ef4444",
  created: "#f59e0b",
};
