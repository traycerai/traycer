import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { harnessDisplayName } from "@/components/session-import/session-import-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * The single line the imported-chat marker paints.
 *
 * Lives apart from the component so chat find can index the text the marker
 * RENDERS. Find used to build its own string from the raw harness id, which
 * made the row unfindable by the provider name it shows on screen - the exact
 * drift a duplicated format string invites, and the reason this is one
 * function rather than two that happen to agree today.
 */
export function importedChatMarkerLabel(input: {
  readonly sourceProvider: GuiHarnessId;
  readonly importedAt: number;
}): string {
  const provider = harnessDisplayName(input.sourceProvider);
  return `Imported from ${provider} · ${formatAbsoluteDateTime(input.importedAt)}`;
}
