import {
  handPendingSandboxSend,
  returnPendingSandboxSendOnItsSandbox,
  type PendingSandboxSendInput,
  type PublishedPendingSandboxHandoff,
} from "@/lib/sandboxes/pending-sandbox-send";
import {
  readDraftAuthorityOutbox,
  type DraftAuthorityPendingEpicEvidence,
} from "@/lib/drafts/draft-authority-pending";
import { confirmPendingSandboxOutboxEpic } from "@/lib/sandboxes/pending-sandbox-authority";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import { readStagedSandbox } from "@/stores/composer/staged-sandbox-store";

/**
 * Where a given-back message went: `opened`, back in its composer on its
 * sandbox; `saved`, put away in Drafts with its sandbox, because the
 * composer holds a newer choice.
 */
export type LandingGiveBack =
  | { readonly kind: "opened"; readonly draftId: string }
  | { readonly kind: "saved"; readonly draftId: string };

export interface LandingSandboxSendHandoff extends PublishedPendingSandboxHandoff {
  readonly isCurrent: () => Promise<boolean>;
  readonly confirm: (evidence: DraftAuthorityPendingEpicEvidence) => Promise<boolean>;
  /** Returns the message; a setup that fails leaves no task to keep it. */
  readonly giveBack: () => Promise<LandingGiveBack | null>;
}

/** Landing setup returns its destination with the message if create or attach fails. */
export async function handLandingSandboxSend(
  input: Omit<PendingSandboxSendInput, "request" | "epicConfirmed">,
): Promise<LandingSandboxSendHandoff | null> {
  const actor = input.actor ?? captureDraftAuthorityActor();
  if (actor === null) return null;
  const published = await handPendingSandboxSend({
    ...input,
    actor,
    request: { kind: "chat", parentId: null, placement: null },
    epicConfirmed: false,
  });
  if (published === null) return null;
  const { id } = published;
  const isCurrent = async (): Promise<boolean> => {
    const result = await readDraftAuthorityOutbox({ actor, sendId: id });
    return result.kind === "current" &&
      draftAuthorityActorIsCurrent(actor) &&
      result.outbox.decision.kind === "waiting" &&
      result.outbox.ownership === "setup";
  };
  return {
    ...published,
    isCurrent,
    confirm: async (evidence) => {
      const result = await readDraftAuthorityOutbox({ actor, sendId: id });
      if (
        result.kind !== "current" ||
        !draftAuthorityActorIsCurrent(actor) ||
        result.outbox.send.epicId !== published.epicId ||
        result.outbox.decision.kind !== "waiting" ||
        result.outbox.ownership !== "setup"
      ) return false;
      return confirmPendingSandboxOutboxEpic({
        actor,
        sendId: id,
        actionId: id,
        expectedGeneration: result.outbox.generation,
        evidence,
      });
    },
    giveBack: async () => {
      if (!(await isCurrent())) return null;
      const saved = readStagedSandbox(input.fromSurfaceKey) !== null;
      const returned = await returnPendingSandboxSendOnItsSandbox(id);
      return returned.kind === "landing-draft"
        ? { kind: saved ? "saved" : "opened", draftId: returned.draftId }
        : null;
    },
  };
}
