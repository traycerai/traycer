import type { ReactNode } from "react";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";

/**
 * STUB (P1 replaces its body): the team rows of the Environment dropdown,
 * drawn after Personal and its Local rows, under a `DropdownMenuSeparator`
 * this component draws itself, with `EnvironmentPickerRow` inside the
 * picker's radio group (`environmentPickValue` for each value). Picking a
 * team row calls `onPick` with a `team` pick. Renders nothing until filled.
 */
export interface TeamRowsProps {
  readonly pick: EnvironmentPick;
  readonly onPick: (pick: EnvironmentPick) => void;
}

export function TeamRows(_props: TeamRowsProps): ReactNode {
  return null;
}
