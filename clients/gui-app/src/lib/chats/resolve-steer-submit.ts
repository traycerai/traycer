import type {
  ChatActiveTurn,
  ChatQueueDeliveryPolicy,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Which composer key produced a submit. Plain `Enter` keeps queueing; `Mod-Enter`
 * (Cmd/Ctrl+Enter) means "steer the running turn now" when the surrounding
 * conditions allow it (see `resolveSubmitDeliveryPolicy`).
 */
export type ChatComposerSubmitSource = "enter" | "mod-enter";

export interface SteerSubmitConditions {
  readonly source: ChatComposerSubmitSource;
  /**
   * The chat's active-turn status, or `null` when no turn is running. Steering
   * only applies while a turn is genuinely `running` (decisions 1, 4, 13): an
   * idle `Mod-Enter` is a plain submit alias, and `stopping` stays inert via the
   * submit hook's own guard.
   */
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  /**
   * The app-wide opt-out preference (default ON - decision 17). When disabled,
   * `Mod-Enter` reverts to the plain-Enter queue alias - the ONLY true Enter
   * alias for the chord.
   */
  readonly steerEnabled: boolean;
  /**
   * Whether the tab's negotiated `chat.subscribe` protocol version understands
   * the `after_safe_point` explicit-steer signal (host handshake minor >= 5). A
   * new renderer paired with a released <=1.4 host must NOT emit
   * `after_safe_point`: that host predates same-turn steering and would inject
   * the message under whatever ordering/settings it does understand. When the
   * protocol lacks steer support, `Mod-Enter` behaves as plain Enter (`auto`).
   * Distinct from harness capability (`steerCapable`): this is the wire
   * contract, not whether the running turn's harness can fold in a steer.
   */
  readonly steerProtocolSupported: boolean;
}

/**
 * Resolves the wire `deliveryPolicy` for a composer submit purely from the
 * submit source and the running-turn conditions. `"after_safe_point"` is the
 * explicit-steer signal the host resolves - jumping same-turn injection when it
 * can fold in, interrupt-restart on confirmed drift, or a labeled next-turn
 * fallback otherwise. Deliberately NOT gated on harness capability: an
 * unsupported harness still sends `after_safe_point` so the host records the
 * downgrade as a fallback ("After turn") row (decisions 5, 11) rather than the
 * renderer erasing the steer intent into a plain `"auto"`. Capability gates only
 * the discovery hints (see `steerHintIsActive`). It IS gated on
 * `steerProtocolSupported` - the negotiated wire version - so a new renderer
 * never speaks `after_safe_point` to a released <=1.4 host that predates
 * steering. Pure so the renderer's submit-path resolution is unit-testable in
 * isolation.
 */
export function resolveSubmitDeliveryPolicy(
  conditions: SteerSubmitConditions,
): ChatQueueDeliveryPolicy {
  if (conditions.source !== "mod-enter") return "auto";
  if (!conditions.steerEnabled) return "auto";
  if (!conditions.steerProtocolSupported) return "auto";
  if (conditions.activeTurnStatus !== "running") return "auto";
  return "after_safe_point";
}

/**
 * Whether the running-turn conditions make `Mod-Enter` a live steer affordance,
 * used to gate the discovery placeholder hint. Mirrors
 * `resolveSubmitDeliveryPolicy`'s steer preconditions minus the per-submit
 * source, so a hint shows exactly when a `Mod-Enter` would steer rather than
 * queue.
 */
export function steerHintIsActive(conditions: {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly steerCapable: boolean;
  readonly steerEnabled: boolean;
}): boolean {
  return (
    conditions.steerEnabled &&
    conditions.activeTurnStatus === "running" &&
    conditions.steerCapable
  );
}
