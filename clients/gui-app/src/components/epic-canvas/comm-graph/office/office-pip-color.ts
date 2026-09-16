/**
 * What a status LOOKS like, in one place.
 *
 * The floor draws a pip per agent at overview zoom and the directory draws the
 * same pip per row in the DOM; they are the same signal seen twice, and a
 * second copy of this mapping is how "red means crashed" comes to mean two
 * different reds on one screen. Lives beside `office-envelope-tints.ts` for
 * the same reason: a colour vocabulary is not a component, and a component
 * file cannot export one.
 */
import type { OfficePalette } from "@/lib/comm-graph/office/office-pixel-art";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";

export function officePipColor(
  status: OfficeAgentStatus,
  palette: OfficePalette,
): string {
  if (status === "failure" || status === "attention") return palette.attention;
  if (status === "awaiting") return palette.notice;
  if (status === "working") return palette.screenLit;
  if (status === "background") return palette.leafLight;
  if (status === "archived") return palette.textMuted;
  return palette.metalLight;
}
