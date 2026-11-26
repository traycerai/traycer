import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  captureDraftAuthorityActor,
  draftAuthorityOptionalActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import {
  beginDesktopDraftAttach,
  type DesktopDraftAttachAdmission,
} from "@/lib/windows/desktop-draft-topology";
import {
  readCanonicalLandingDraft,
  reserveCanonicalLandingDraft,
} from "@/stores/home/landing-draft-store";

let sessionChange = 0;
subscribeToDraftAuthoritySessionChanges(() => { sessionChange += 1; });

export function captureDesktopLandingDraftPress() {
  const actor = captureDraftAuthorityActor();
  const generation = sessionChange;
  return {
    actor,
    admission: beginDesktopDraftAttach(),
    isCurrent: (): boolean =>
      generation === sessionChange && draftAuthorityOptionalActorIsCurrent(actor),
  };
}

/** The reserved row stays closed until the acknowledged exact local alias projects. */
export async function attachNewDesktopLandingDraft(input: {
  readonly admission: Extract<DesktopDraftAttachAdmission, { kind: "ready" }>;
  readonly draftId: string;
  readonly settings: ChatRunSettings | null;
  readonly activate: boolean;
  readonly isCurrent: () => boolean;
}): Promise<boolean> {
  const { admission, draftId, settings, activate, isCurrent } = input;
  if (!isCurrent()) return false;
  const reserved = await reserveCanonicalLandingDraft(draftId, settings);
  if (reserved.kind !== "committed" || !isCurrent()) return false;
  const live = await readCanonicalLandingDraft(reserved.draft);
  if (live.kind !== "live" || live.draft.version !== reserved.draft.version || !isCurrent())
    return false;
  const result = await admission.attach({
    references: [reserved.draft],
    activateDraftId: activate ? draftId : null,
    isCurrent,
  });
  return result.kind === "attached" && isCurrent();
}
