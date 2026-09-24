/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Rules).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { PendingRuleDraft } from "@/components/settings/panels/auto-policy-document";
import type { RulesEditorState } from "@/components/settings/panels/permissions/rules-tab";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

/**
 * The Rules edit as Settings holds it across remounts of the editor: the
 * editor's last committed state, and the drafts handed to Rules that it has
 * not taken yet. `viewerId` is the account it belongs to; `""` until one is
 * known. `appliedIntentId` is the last open intent whose draft was queued, so
 * the same card's draft is never queued twice.
 */
export interface RulesEdit {
  readonly viewerId: string;
  readonly snapshot: RulesEditorState | null;
  readonly nextDraftId: number;
  readonly drafts: ReadonlyArray<PendingRuleDraft>;
  readonly appliedIntentId: number | null;
}

/**
 * The Rules edit, and the ways it changes: a draft handed to Rules (by the
 * page, or by an open intent), the editor taking drafts, and the editor
 * committing a state.
 */
export interface RulesEditHandle {
  readonly edit: RulesEdit;
  readonly enqueueDraft: (draft: SettingsRuleDraft) => void;
  /**
   * Queues an open intent's draft, once per intent id: a page that remounts,
   * or an effect that runs twice, before the intent is acknowledged hands the
   * same one again.
   */
  readonly enqueueIntentDraft: (
    intentId: number,
    draft: SettingsRuleDraft,
  ) => void;
  readonly onDraftsConsumed: (throughId: number) => void;
  readonly onSnapshot: (editor: RulesEditorState) => void;
}

export interface RulesEditStoreState {
  readonly edit: RulesEdit;
  /**
   * A promotion is carrying the edit from the modal into the Settings tab.
   * While set, Settings reading as closed is the gap between the modal going
   * and the tab arriving, not a close.
   */
  readonly handoffPending: boolean;
}

const EMPTY_EDIT: RulesEdit = {
  viewerId: "",
  snapshot: null,
  nextDraftId: 1,
  drafts: [],
  appliedIntentId: null,
};

/**
 * The Rules edit of THIS window's Settings, whichever way Settings is shown.
 *
 * Settings is one instance per window - the modal, or the Settings tab, never
 * both: `openSettings` focuses an existing tab rather than opening the modal
 * over it, and "Open as tab" closes the modal it promotes. No component lives
 * as long as that instance does. The modal's content remounts when its
 * modality changes (the theme editor releases it), a promotion replaces the
 * modal's body with the tab's, and a hidden Settings tab is unmounted by the
 * strip's MRU window and rebuilt from the tabs store (`durableState:
 * reconstruct`). So the edit lives here, and only an actual close resets it
 * (`useRulesEditLifetime`), with Discard and a switch of account.
 *
 * Module-private: Settings reads it through `useRulesEdit`, and nothing
 * outside Settings reads it at all. Not persisted - a reload is a close.
 */
const useRulesEditStore = create<RulesEditStoreState>(() => ({
  edit: EMPTY_EDIT,
  handoffPending: false,
}));

/**
 * Another account's edit is not this one's to keep. An id arriving where none
 * was known is the same viewer resolving, and keeps the edit; an id going away
 * (signing out) records nothing, so the next account is compared against the
 * last one known.
 */
function editForViewer(edit: RulesEdit, viewerId: string): RulesEdit {
  if (viewerId === "" || edit.viewerId === viewerId) return edit;
  if (edit.viewerId === "") return { ...edit, viewerId };
  return { ...edit, viewerId, snapshot: null, drafts: [] };
}

function editWithDraft(edit: RulesEdit, draft: SettingsRuleDraft): RulesEdit {
  return {
    ...edit,
    nextDraftId: edit.nextDraftId + 1,
    drafts: [...edit.drafts, { id: edit.nextDraftId, draft }],
  };
}

/** Every write goes through the viewer partition first. */
function writeEdit(
  viewerId: string,
  change: (edit: RulesEdit) => RulesEdit,
): void {
  useRulesEditStore.setState((state) => {
    const next = change(editForViewer(state.edit, viewerId));
    return next === state.edit ? state : { edit: next };
  });
}

/** The Rules edit of this window's Settings, for the Permissions page. */
export function useRulesEdit(): RulesEditHandle {
  const viewerId = useCloudChatViewerId();
  const stored = useRulesEditStore((state) => state.edit);
  // The partition on READ, so no frame shows one account another's edit...
  const edit = useMemo(
    () => editForViewer(stored, viewerId),
    [stored, viewerId],
  );
  // ...and written back, so the drop is permanent: switching back to the
  // first account does not bring its edit back.
  useEffect(() => {
    if (edit !== stored) writeEdit(viewerId, (current) => current);
  }, [edit, stored, viewerId]);
  const enqueueDraft = useCallback(
    (draft: SettingsRuleDraft): void => {
      writeEdit(viewerId, (current) => editWithDraft(current, draft));
    },
    [viewerId],
  );
  const enqueueIntentDraft = useCallback(
    (intentId: number, draft: SettingsRuleDraft): void => {
      writeEdit(viewerId, (current) =>
        current.appliedIntentId === intentId
          ? current
          : { ...editWithDraft(current, draft), appliedIntentId: intentId },
      );
    },
    [viewerId],
  );
  const onDraftsConsumed = useCallback(
    (throughId: number): void => {
      writeEdit(viewerId, (current) =>
        current.drafts.every((entry) => entry.id > throughId)
          ? current
          : {
              ...current,
              drafts: current.drafts.filter((entry) => entry.id > throughId),
            },
      );
    },
    [viewerId],
  );
  const onSnapshot = useCallback(
    (editor: RulesEditorState): void => {
      writeEdit(viewerId, (current) =>
        current.snapshot === editor
          ? current
          : { ...current, snapshot: editor },
      );
    },
    [viewerId],
  );
  return useMemo(
    () => ({
      edit,
      enqueueDraft,
      enqueueIntentDraft,
      onDraftsConsumed,
      onSnapshot,
    }),
    [edit, enqueueDraft, enqueueIntentDraft, onDraftsConsumed, onSnapshot],
  );
}

/**
 * Marks a promotion: the modal is about to close so the Settings tab can open
 * with the same edit. Called from the Settings overlay's
 * `prepareForPromotion`, while the modal's body is still mounted.
 */
export function beginRulesEditHandoff(): void {
  useRulesEditStore.setState({ handoffPending: true });
}

/**
 * Ends a handoff whose promotion was refused: the modal stays open and no tab
 * arrives, so its later close is a close again.
 */
export function cancelRulesEditHandoff(): void {
  useRulesEditStore.setState({ handoffPending: false });
}

/**
 * Ties the edit to the life of this window's Settings: reset on the
 * transition from open to closed, and never while a promotion is between the
 * modal and the tab. Mounted once, in the always-mounted `SystemTabModalHost`,
 * which WRITES the store and reads nothing from it.
 *
 * `settingsOpen` is "the modal shows Settings, or the Settings tab exists";
 * `settingsTabOpen` is the second half alone. The handoff ends when Settings
 * next reads as open, and in particular when the tab appears: a promotion
 * whose modal close and tab creation land in one commit never reads as
 * closed, so the tab's arrival is what settles it.
 */
export function useRulesEditLifetime(
  settingsOpen: boolean,
  settingsTabOpen: boolean,
): void {
  useEffect(() => {
    if (!settingsOpen && !settingsTabOpen) return;
    if (useRulesEditStore.getState().handoffPending) {
      useRulesEditStore.setState({ handoffPending: false });
    }
  }, [settingsOpen, settingsTabOpen]);
  useEffect(() => {
    if (settingsOpen) return;
    // A promotion in flight: the modal has gone and the tab has not arrived.
    if (useRulesEditStore.getState().handoffPending) return;
    useRulesEditStore.setState({ edit: EMPTY_EDIT });
  }, [settingsOpen]);
}

/** Test-only: an empty edit, no handoff. */
export function resetRulesEditForTests(): void {
  useRulesEditStore.setState({ edit: EMPTY_EDIT, handoffPending: false });
}

/** Test-only: what the store holds, unpartitioned. */
export function readRulesEditForTests(): RulesEditStoreState {
  return useRulesEditStore.getState();
}
