import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import { noEditorInstalledMessage } from "@/lib/editor/editor-menu-catalog";
import { editorQueryKeys } from "@/lib/query-keys";

const NO_EDITOR_INSTALLED_TOAST_ID = "no-editor-installed";

/**
 * What a no-menu open button does when `useEffectiveDefaultEditor` has nothing
 * to send: say which editors `hostId` can open, instead of asking the host to
 * launch one that is not installed.
 *
 * The toast has a stable id, so a button that stays enabled does not stack one
 * per click. The install probe is cached for minutes, so each notice also
 * invalidates it: a user who installs an editor and clicks again gets a fresh
 * answer rather than the same toast.
 */
export function useNoEditorInstalledNotice(hostId: string | null): () => void {
  const editors = useOfferableEditors(hostId);
  const queryClient = useQueryClient();
  return useCallback(() => {
    toast.info(noEditorInstalledMessage(editors), {
      id: NO_EDITOR_INSTALLED_TOAST_ID,
    });
    void queryClient.invalidateQueries({
      queryKey: editorQueryKeys.availabilityAll(),
    });
  }, [editors, queryClient]);
}
