import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { useDraftAppearance } from "@/hooks/appearance/use-workspace-appearance";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";

const EMPTY_FOLDERS: readonly string[] = [];

export function useLandingDraftAppearance(draftId: string | null) {
  return useDraftAppearance(useLandingDraftAppearanceSource(draftId));
}

export function useLandingDraftAppearanceSource(draftId: string | null) {
  const hostId = useComposerPlacement(null).target.resolvedHostId;
  const workspace = useLandingDraftStore(
    (state) =>
      state.drafts.find((draft) => draft.id === draftId)?.workspace ?? null,
  );
  const global = useWorkspaceFoldersStore((state) =>
    selectWorkspaceFoldersBucket(state, hostId),
  );
  const source = draftId === null ? global : workspace;
  return {
    hostId,
    folders: source?.folders ?? EMPTY_FOLDERS,
    primaryPath: source?.primaryPath ?? null,
  };
}
