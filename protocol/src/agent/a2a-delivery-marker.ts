/**
 * Shared wire format for the lifecycle-v2 TUI delivery marker.
 *
 * The monitor prefixes its task-notification body with a single-line marker
 * so the host's causal service-proof parser can bind an admitted notification
 * UUID to a concrete delivery id. Extraction is deliberately unanchored:
 * the marker must be found inside a structured `<task-notification>` body,
 * never assumed to sit at byte zero of the whole transcript content.
 */

export const AGENT_DELIVERY_MARKER_LINE_PREFIX =
  "[traycer:delivery-marker]" as const;

const DELIVERY_ID_PATTERN = 'deliveryId="([^"]+)"';
const MARKER_LINE_PATTERN = new RegExp(
  String.raw`\[traycer:delivery-marker\]\s+${DELIVERY_ID_PATTERN}`,
);
const TASK_NOTIFICATION_BODY_PATTERN =
  /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/i;

export interface AgentDeliveryMarker {
  readonly deliveryId: string;
}

export function formatAgentDeliveryMarker(
  marker: AgentDeliveryMarker,
): string {
  return `${AGENT_DELIVERY_MARKER_LINE_PREFIX} deliveryId="${marker.deliveryId}"`;
}

/**
 * Find a delivery marker anywhere in `content` (not required at byte zero).
 * Returns null when no well-formed marker is present.
 */
export function extractAgentDeliveryMarkerUnanchored(
  content: string,
): AgentDeliveryMarker | null {
  const match = MARKER_LINE_PATTERN.exec(content);
  if (match === null) {
    return null;
  }
  const deliveryId = match[1];
  if (deliveryId.length === 0) {
    return null;
  }
  return { deliveryId };
}

/**
 * Extract the marker from a structured `<task-notification>` body.
 * The search is unanchored within the body: leading wrapper text, XML
 * attributes, or preamble before the marker do not disqualify a match.
 * Returns null when the content has no task-notification wrapper or the
 * body contains no well-formed marker.
 */
export function extractAgentDeliveryMarkerFromTaskNotification(
  content: string,
): AgentDeliveryMarker | null {
  const bodyMatch = TASK_NOTIFICATION_BODY_PATTERN.exec(content);
  if (bodyMatch === null) {
    return null;
  }
  return extractAgentDeliveryMarkerUnanchored(bodyMatch[1]);
}
