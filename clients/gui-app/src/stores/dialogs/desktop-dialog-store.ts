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
  /**
   * G2: the most recent CONFIRMED (delivered) report id for the draft
   * currently showing its confirmation screen - cleared on any intentional
   * close (`close`/`closeReportIssueDraft`), so it only survives to be read
   * by `ReportIssueDialogHost` when a new report trigger fires WHILE that
   * confirmation is still on screen (never after the user already dismissed
   * it). A replacement then toasts this id before the draft below is
   * overwritten, since the confirmation holds the only copy of it.
   */
  readonly lastConfirmedReport: {
    readonly draftId: number;
    readonly reportId: string;
  } | null;
  readonly openAboutDetails: () => void;
  readonly openLogs: () => void;
  readonly openEpicInNewWindow: () => void;
  readonly openReportIssue: () => void;
  readonly openReportIssueWithContext: (context: ReportIssueContext) => void;
  /** Used by surfaces that captured a structured private cause (T3 migration). */
  readonly openReportIssueDraft: (draft: ReportIssueDraftContext) => void;
  readonly closeReportIssueDraft: (draftId: number) => void;
  readonly setReportIssueAvailable: (available: boolean) => void;
  readonly setLastConfirmedReport: (
    report: { readonly draftId: number; readonly reportId: string } | null,
  ) => void;
  readonly openInstallGuidance: () => void;
  readonly close: () => void;
}

export const useDesktopDialogStore = create<DesktopDialogState>((set) => ({
  activeDialog: null,
  reportIssueAvailable: false,
  reportIssueContext: null,
  reportIssueDraftContext: null,
  reportIssueDraftId: 0,
  lastConfirmedReport: null,
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
    const draftContext = buildReportIssueDraftContext(context, null);
    set((state) => ({
      activeDialog: "report-issue",
      reportIssueContext: context,
      reportIssueDraftContext: draftContext,
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
            lastConfirmedReport: null,
          }
        : state,
    );
  },
  setReportIssueAvailable: (available) => {
    set({ reportIssueAvailable: available });
  },
  setLastConfirmedReport: (report) => {
    set({ lastConfirmedReport: report });
  },
  openInstallGuidance: () => {
    set({ activeDialog: "install-guidance" });
  },
  close: () => {
    set({
      activeDialog: null,
      reportIssueContext: null,
      reportIssueDraftContext: null,
      lastConfirmedReport: null,
    });
  },
}));
