import { create } from "zustand";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import {
  buildReportIssueDraftContext,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";

export type DesktopDialogKind =
  | "about-details"
  | "logs"
  | "open-epic-in-new-window"
  | "report-issue"
  | "install-guidance";

export interface DesktopDialogState {
  readonly activeDialog: DesktopDialogKind | null;
  readonly reportIssueAvailable: boolean;
  readonly reportIssueContext: ReportIssueContext | null;
  /**
   * Full draft context (public prefill + private diagnostics), captured
   * immutably at open time alongside `reportIssueDraftId`. `reportIssueContext`
   * stays the back-compat field existing readers use; this is additive so
   * ticket 04's IPC wiring can read `privateDiagnostics` without touching the
   * existing contract.
   */
  readonly reportIssueDraftContext: ReportIssueDraftContext | null;
  readonly reportIssueDraftId: number;
  readonly openAboutDetails: () => void;
  readonly openLogs: () => void;
  readonly openEpicInNewWindow: () => void;
  readonly openReportIssue: () => void;
  readonly openReportIssueWithContext: (context: ReportIssueContext) => void;
  /** Used by surfaces that captured a structured private cause (T3 migration). */
  readonly openReportIssueDraft: (draft: ReportIssueDraftContext) => void;
  readonly closeReportIssueDraft: (draftId: number) => void;
  readonly setReportIssueAvailable: (available: boolean) => void;
  readonly openInstallGuidance: () => void;
  readonly close: () => void;
}

export const useDesktopDialogStore = create<DesktopDialogState>((set) => ({
  activeDialog: null,
  reportIssueAvailable: false,
  reportIssueContext: null,
  reportIssueDraftContext: null,
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
      reportIssueDraftContext: null,
      reportIssueDraftId: state.reportIssueDraftId + 1,
    }));
  },
  openReportIssueWithContext: (context) => {
    set((state) => ({
      activeDialog: "report-issue",
      reportIssueContext: context,
      reportIssueDraftContext: buildReportIssueDraftContext(context, null),
      reportIssueDraftId: state.reportIssueDraftId + 1,
    }));
  },
  openReportIssueDraft: (draft) => {
    set((state) => ({
      activeDialog: "report-issue",
      reportIssueContext: draft.publicPrefill,
      reportIssueDraftContext: draft,
      reportIssueDraftId: state.reportIssueDraftId + 1,
    }));
  },
  closeReportIssueDraft: (draftId) => {
    set((state) =>
      state.activeDialog === "report-issue" &&
      state.reportIssueDraftId === draftId
        ? {
            activeDialog: null,
            reportIssueContext: null,
            reportIssueDraftContext: null,
          }
        : state,
    );
  },
  setReportIssueAvailable: (available) => {
    set({ reportIssueAvailable: available });
  },
  openInstallGuidance: () => {
    set({ activeDialog: "install-guidance" });
  },
  close: () => {
    set({
      activeDialog: null,
      reportIssueContext: null,
      reportIssueDraftContext: null,
    });
  },
}));
