import { captureDraftAuthorityActor } from "@/lib/drafts/draft-authority-session";
import {
  returnedSandboxForDraft,
  returnedStageMatchesDraft,
} from "@/lib/sandboxes/returned-sandbox";
import type { StagedRunRequest } from "@/lib/sandboxes/staged-sandbox-run";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import {
  captureCanonicalTaskDraft,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import {
  captureCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

export function captureRestoredDraftAction(
  stage: StagedSandbox,
): NonNullable<StagedRunRequest["restoredDraftAuthority"]> | null {
  const origin = stage.returnedDraft;
  if (origin === undefined) return null;
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== origin.userId) return null;

  const { kind, draftId } = origin;
  const task =
    kind === "task"
      ? useNewConversationModalStore.getState().draftPatchesByEpicId[
          origin.epicId
        ]
      : undefined;
  if (kind === "task" && (task?.draftId ?? null) !== draftId) return null;
  const returned =
    kind === "task"
      ? task?.returnedSandbox
      : useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.returnedSandbox;
  const stored = returnedSandboxForDraft(returned ?? null, actor.accountId, kind, draftId);
  if (stored === null || !returnedStageMatchesDraft(stored, origin, stage))
    return null;
  const draft =
    kind === "task"
      ? captureCanonicalTaskDraft(origin.epicId)
      : captureCanonicalLandingDraft(origin.draftId);
  return draft === null
    ? null
    : {
        actor,
        source: { kind: "restored-draft", draft, returnAccountId: actor.accountId },
        stored,
      };
}
