import { create } from "zustand";

export type DesktopDialogKind =
  | "about-details"
  | "logs"
  | "open-epic-in-new-window"
  | "report-issue"
  | "confirm-restart-update"
  | "install-guidance";

export interface DesktopDialogState {
  readonly activeDialog: DesktopDialogKind | null;
  readonly openAboutDetails: () => void;
  readonly openLogs: () => void;
  readonly openEpicInNewWindow: () => void;
  readonly openReportIssue: () => void;
  readonly openConfirmRestartUpdate: () => void;
  readonly openInstallGuidance: () => void;
  readonly close: () => void;
}

export const useDesktopDialogStore = create<DesktopDialogState>((set) => ({
  activeDialog: null,
  openAboutDetails: () => {
    set({ activeDialog: "about-details" });
  },
  openLogs: () => {
    set({ activeDialog: "logs" });
  },
  openEpicInNewWindow: () => {
    set({ activeDialog: "open-epic-in-new-window" });
  },
  openReportIssue: () => {
    set({ activeDialog: "report-issue" });
  },
  openConfirmRestartUpdate: () => {
    set({ activeDialog: "confirm-restart-update" });
  },
  openInstallGuidance: () => {
    set({ activeDialog: "install-guidance" });
  },
  close: () => {
    set({ activeDialog: null });
  },
}));
