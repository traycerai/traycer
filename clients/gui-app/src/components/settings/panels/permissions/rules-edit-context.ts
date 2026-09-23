/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Rules).
 * Update that file whenever this settings surface changes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
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

/**
 * The Rules edit of the Settings instance around it, provided by
 * `RulesEditScope` at each Settings surface's root: above the section
 * switch, so leaving Permissions for another section and coming back keeps
 * it, and gone with the surface, so closing Settings resets it.
 */
export const RulesEditContext = createContext<RulesEditHandle | null>(null);

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

/** The state behind a `RulesEditScope`. */
export function useRulesEditState(): RulesEditHandle {
  const viewerId = useCloudChatViewerId();
  const [edit, setEdit] = useState<RulesEdit>({
    viewerId,
    snapshot: null,
    nextDraftId: 1,
    drafts: [],
    appliedIntentId: null,
  });
  const current = editForViewer(edit, viewerId);
  if (current !== edit) setEdit(current);
  const enqueueDraft = useCallback((draft: SettingsRuleDraft): void => {
    setEdit((latest) => editWithDraft(latest, draft));
  }, []);
  const enqueueIntentDraft = useCallback(
    (intentId: number, draft: SettingsRuleDraft): void => {
      setEdit((latest) =>
        latest.appliedIntentId === intentId
          ? latest
          : { ...editWithDraft(latest, draft), appliedIntentId: intentId },
      );
    },
    [],
  );
  const onDraftsConsumed = useCallback((throughId: number): void => {
    setEdit((latest) =>
      latest.drafts.every((entry) => entry.id > throughId)
        ? latest
        : {
            ...latest,
            drafts: latest.drafts.filter((entry) => entry.id > throughId),
          },
    );
  }, []);
  const onSnapshot = useCallback((editor: RulesEditorState): void => {
    setEdit((latest) =>
      latest.snapshot === editor ? latest : { ...latest, snapshot: editor },
    );
  }, []);
  return useMemo(
    () => ({
      edit: current,
      enqueueDraft,
      enqueueIntentDraft,
      onDraftsConsumed,
      onSnapshot,
    }),
    [current, enqueueDraft, enqueueIntentDraft, onDraftsConsumed, onSnapshot],
  );
}

/** Whether a `RulesEditScope` is mounted above. */
export function useHasRulesEditScope(): boolean {
  return useContext(RulesEditContext) !== null;
}

/** The Rules edit of the `RulesEditScope` above; there must be one. */
export function useRulesEdit(): RulesEditHandle {
  const handle = useContext(RulesEditContext);
  if (handle === null) {
    throw new Error("useRulesEdit needs a RulesEditScope above it");
  }
  return handle;
}
