import { create } from "zustand";
import type { ReportIssueContext } from "@/lib/report-issue-context";

export type DesktopDialogKind =
  | "about-details"
  | "logs"
  | "open-epic-in-new-window"
  | "report-issue"
  | "confirm-restart-update"
  | "install-guidance";

export interface DesktopDialogState {
  readonly activeDialog: DesktopDialogKind | null;
  readonly reportIssueAvailable: boolean;
  readonly reportIssueContext: ReportIssueContext | null;
  readonly reportIssueDraftId: number;
  readonly openAboutDetails: () => void;
  readonly openLogs: () => void;
  readonly openEpicInNewWindow: () => void;
  readonly openReportIssue: () => void;
  readonly openReportIssueWithContext: (context: ReportIssueContext) => void;
  readonly closeReportIssueDraft: (draftId: number) => void;
  readonly setReportIssueAvailable: (available: boolean) => void;
  readonly openConfirmRestartUpdate: () => void;
  readonly openInstallGuidance: () => void;
  readonly close: () => void;
}

export const useDesktopDialogStore = create<DesktopDialogState>((set) => ({
  activeDialog: null,
  reportIssueAvailable: false,
  reportIssueContext: null,
  reportIssueDraftId: 0,
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
    set((state) => ({
      activeDialog: "report-issue",
      reportIssueContext: null,
      reportIssueDraftId: state.reportIssueDraftId + 1,
    }));
  },
  openReportIssueWithContext: (context) => {
    set((state) => ({
      activeDialog: "report-issue",
      reportIssueContext: context,
      reportIssueDraftId: state.reportIssueDraftId + 1,
    }));
  },
  closeReportIssueDraft: (draftId) => {
    set((state) =>
      state.activeDialog === "report-issue" &&
      state.reportIssueDraftId === draftId
        ? { activeDialog: null, reportIssueContext: null }
        : state,
    );
  },
  setReportIssueAvailable: (available) => {
    set({ reportIssueAvailable: available });
  },
  openConfirmRestartUpdate: () => {
    set({ activeDialog: "confirm-restart-update" });
  },
  openInstallGuidance: () => {
    set({ activeDialog: "install-guidance" });
  },
  close: () => {
    set({ activeDialog: null, reportIssueContext: null });
  },
}));
