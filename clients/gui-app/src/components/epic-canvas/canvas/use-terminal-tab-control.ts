import { useEpicTerminalAuthority } from "@/hooks/terminal/use-epic-terminal-authority";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

/**
 * A terminal tab's title and rename through its host authority: the plain
 * verbs (`terminal.plain.rename`, the projection's title) on a capable host,
 * and `mode` telling the caller when to fall back to the legacy reads
 * (`terminal.list`, `terminal.rename`).
 */
export interface TerminalTabControl {
  readonly mode: "unknown" | "legacy" | "capable";
  readonly displayTitle: string;
  readonly canMutate: boolean;
  readonly rename: (title: string) => void;
}

/**
 * Shared by the tab strip and the phone's current-tile bar, so a terminal
 * renames the same way on both. A host that serves only the plain verbs (the
 * Automations host) is never sent the legacy ones.
 */
export function useTerminalTabControl(
  epicId: string,
  tab: EpicTerminalRef,
): TerminalTabControl {
  const controller = useEpicTerminalAuthority({ epicId, node: tab });
  const rename = controller.rename;
  const terminalId = tab.id;
  const canMutate =
    controller.canMutate &&
    !controller.migrationPending &&
    controller.projection !== undefined;
  return {
    mode: controller.capability,
    displayTitle: controller.viewModel?.displayTitle ?? tab.name,
    canMutate,
    rename: (title) => {
      if (!controller.canMutate) return;
      rename.mutate({
        hostId: tab.hostId,
        terminalId,
        manualTitle: title,
      });
    },
  };
}

/**
 * Whether the legacy title read applies: only on a `legacy` host (or a tile
 * with no authority). Not while the mode is still `unknown`: the title then
 * comes from the authority anyway, and a host that serves only the plain
 * verbs (the Automations host) would refuse the read.
 */
export function terminalTabUsesLegacyReads(
  control: TerminalTabControl | null,
): boolean {
  return control === null || control.mode === "legacy";
}

/** The title to show: the authority's once it is capable or still deciding. */
export function terminalTabDisplayTitle(
  control: TerminalTabControl | null,
  fallbackTitle: string,
): string {
  if (control?.mode === "capable" || control?.mode === "unknown") {
    return control.displayTitle;
  }
  return fallbackTitle;
}

/** Whether a rename may be offered, as far as the terminal's authority says. */
export function terminalTabRenamable(
  control: TerminalTabControl | null,
): boolean {
  if (control === null || control.mode === "legacy") return true;
  return control.mode === "capable" && control.canMutate;
}
