import { useCallback } from "react";
import {
  composerDraftRowIsForeign,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  useDraftAuthorityControl,
  type DraftAuthorityControl,
} from "./use-draft-authority";

/**
 * The fork rule for the chat composer. A chat draft names a surface that
 * exists only on the chat's host, so a foreign row here is this host's own
 * row demoted to a replica (or one another host owns): the first edit
 * re-keys it (`detachDraftIdentity`) - the content stays, a fresh id is
 * minted with `supersedes` naming the old one, and the keystroke lands on
 * the fresh row. Nothing is shown.
 */
export function useChatComposerDraftAuthority(args: {
  readonly chatId: string;
  readonly tabHostId: string;
}): DraftAuthorityControl {
  const { chatId, tabHostId } = args;
  const isForeign = useCallback((): boolean => {
    const row = useComposerDraftStore.getState().drafts[chatId];
    if (row === undefined || row.draftId === null) return false;
    return composerDraftRowIsForeign(row, tabHostId);
  }, [chatId, tabHostId]);
  const fork = useCallback((): void => {
    useComposerDraftStore.getState().detachDraftIdentity(chatId);
  }, [chatId]);
  return useDraftAuthorityControl({ isForeign, fork });
}
