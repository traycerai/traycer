import { create } from "zustand";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
import {
  buildReportIssueDraftContext,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";

export type DesktopDialogKind =
  | "about-details"
  | "logs"
  | "open-epic-in-new-window"
  | "report-issue"
  | "install-guidance"
  | "update-unsynced-confirm";

/**
 * What the update-install door learned before it asked. `epics` are the rows
 * the decision is taken against; `otherWindowsUnknown` is true when the
 * APP-WIDE check failed, so `epics` is only this window's answer and every
 * other window's work is unaccounted for - the prompt then has to say so,
 * because "nothing listed" is not "nothing to lose" in that state.
 */
export interface UpdateUnsyncedConfirmation {
  readonly epics: ReadonlyArray<UnsyncedEditsEntry>;
  readonly otherWindowsUnknown: boolean;
}

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
  /**
   * The epics whose work cannot survive an update restart, captured when the
   * confirmation opens. Held here rather than re-derived by the dialog so the
   * rows the user is shown are the ones the decision was taken against - a
   * retention can be reclaimed while the dialog is up, and a body that
   * re-queried would silently disagree with the gate that raised it.
   */
  readonly updateUnsyncedEpics: ReadonlyArray<UnsyncedEditsEntry>;
  /** See {@link UpdateUnsyncedConfirmation.otherWindowsUnknown}. */
  readonly updateUnsyncedOtherWindowsUnknown: boolean;
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
  readonly openUpdateUnsyncedConfirm: (
    confirmation: UpdateUnsyncedConfirmation,
  ) => void;
  readonly close: () => void;
}

export const useDesktopDialogStore = create<DesktopDialogState>((set) => ({
  activeDialog: null,
  reportIssueAvailable: false,
  reportIssueContext: null,
  reportIssueDraftContext: null,
  reportIssueDraftId: 0,
  updateUnsyncedEpics: [],
  updateUnsyncedOtherWindowsUnknown: false,
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
  openUpdateUnsyncedConfirm: (confirmation) => {
    set({
      activeDialog: "update-unsynced-confirm",
      updateUnsyncedEpics: confirmation.epics,
      updateUnsyncedOtherWindowsUnknown: confirmation.otherWindowsUnknown,
    });
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
