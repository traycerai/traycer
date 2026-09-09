import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import type { MessageSegment } from "@/stores/composer/chat-store";

export type MonitorDeliverySegment = Extract<
  MessageSegment,
  { kind: "autonomous_resume" }
>;

export function isShellDelivery(trigger: AutonomousResumeTrigger): boolean {
  return (
    trigger.mcp === null &&
    (trigger.managedCommand !== null || trigger.kind === "monitor")
  );
}

export function isMonitorActivitySegment(
  segment: MessageSegment,
): segment is MonitorDeliverySegment {
  return (
    segment.kind === "autonomous_resume" &&
    segment.deliveryPlacement === "in_turn" &&
    segment.triggers.length > 0 &&
    segment.triggers.every(
      (trigger) => isShellDelivery(trigger) && trigger.live,
    )
  );
}
