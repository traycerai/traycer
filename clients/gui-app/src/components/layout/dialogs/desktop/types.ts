import type { DesktopSupportBridge } from "@/lib/windows/types";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

export interface DesktopSupportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly support: DesktopSupportBridge | null;
}

export type AboutDetailsDialogProps = DesktopSupportDialogProps;

export interface OpenEpicInNewWindowDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly close: () => void;
  readonly flow: EpicNewWindowFlow;
}
