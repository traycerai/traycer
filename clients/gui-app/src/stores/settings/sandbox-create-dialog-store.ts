import { create } from "zustand";
import type { SandboxOs } from "@traycer/protocol/host/sandbox-control";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";

/**
 * What the person has entered, kept here rather than in the form: the form
 * remounts while the dialog stays open (two dialog copies share this store's
 * `open`, and the body's loading gates), and a remount must not bring the
 * defaults back over what was typed.
 */
export interface SandboxCreateDraft {
  readonly name: string;
  readonly os: SandboxOs;
  readonly cpus: string;
  readonly memoryGb: string;
  readonly region: string;
  readonly idleMinutes: number;
  readonly belongsTo: SandboxCreateBelongsTo;
}

/** The last create's failure, said in the dialog while it is open. */
export interface SandboxCreateFailureLine {
  /** The copy for the server's refusal code; never the provider's own text. */
  readonly message: string;
  readonly code: string | null;
}

/** A create that succeeded while the open that sent it was still up. */
export interface SandboxCreatedLine {
  readonly hostId: string;
  /** The team it was created for, `null` for Personal. */
  readonly teamId: string | null;
}

/** "New sandbox…": one store, one mounted dialog, like the add-host dialog. */
interface SandboxCreateDialogState {
  readonly open: boolean;
  /**
   * Which open this is. A create remembers the open that sent it, and its
   * outcome is said in that open only: a later open is a new sandbox, and a
   * create that outlived its open toasts instead.
   */
  readonly openId: number;
  /** The entry's preselection (a team group's New sandbox, "like this"). */
  readonly preselect: SandboxCreateBelongsTo | null;
  /** The team owning the host the person is working from, when it has one. */
  readonly workingHostTeamId: string | null;
  /** `null` until the form first renders after an open. */
  readonly draft: SandboxCreateDraft | null;
  readonly failure: SandboxCreateFailureLine | null;
  /**
   * Set by the create itself rather than the form that sent it, so a form
   * that remounted while the create ran still closes or offers the team task.
   */
  readonly created: SandboxCreatedLine | null;
  readonly openDialog: (
    preselect: SandboxCreateBelongsTo | null,
    workingHostTeamId: string | null,
  ) => void;
  readonly closeDialog: () => void;
  readonly setDraft: (draft: SandboxCreateDraft) => void;
  readonly setFailure: (failure: SandboxCreateFailureLine | null) => void;
  readonly setCreated: (created: SandboxCreatedLine) => void;
}

export const useSandboxCreateDialogStore = create<SandboxCreateDialogState>(
  (set) => ({
    open: false,
    openId: 0,
    preselect: null,
    workingHostTeamId: null,
    draft: null,
    failure: null,
    created: null,
    // A new open is a new sandbox: nothing from the last one carries over.
    openDialog: (preselect, workingHostTeamId) =>
      set((state) => ({
        open: true,
        openId: state.openId + 1,
        preselect,
        workingHostTeamId,
        draft: null,
        failure: null,
        created: null,
      })),
    closeDialog: () =>
      set({ open: false, draft: null, failure: null, created: null }),
    setDraft: (draft) => set({ draft }),
    setFailure: (failure) => set({ failure }),
    setCreated: (created) => set({ created }),
  }),
);

/**
 * The open a create's outcome belongs to, read when it is sent: `null` when
 * the dialog is closed (an agent's or another surface's create).
 */
export function sandboxCreateOpenIdNow(): number | null {
  const state = useSandboxCreateDialogStore.getState();
  return state.open ? state.openId : null;
}

/** Whether the open that sent a create is still the one on screen. */
export function sandboxCreateOpenIsCurrent(openId: number | null): boolean {
  const state = useSandboxCreateDialogStore.getState();
  return openId !== null && state.open && state.openId === openId;
}
