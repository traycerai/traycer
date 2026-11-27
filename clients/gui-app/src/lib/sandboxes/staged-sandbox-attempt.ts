import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { OrdinaryDraftSnapshot } from "@/lib/drafts/draft-mirror-session";
import type {
  StagedSandbox,
  StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

/** The draft custody and execution destination are chosen independently at Send. */
export interface StagedSandboxAttempt {
  readonly id: string;
  readonly userId: string;
  readonly originalHostId: string | null;
  readonly draft: OrdinaryDraftSnapshot;
  readonly sandbox: StagedSandboxTarget;
  readonly createRequestId: string | null;
  readonly firstTurn: {
    readonly epicId: string;
    readonly chatId: string;
    readonly messageId: string;
    readonly clientActionId: string;
    readonly settings: ChatRunSettings;
  };
}

interface StagedSandboxAttemptInput {
  readonly userId: string;
  readonly originalHostId: string | null;
  readonly draft: OrdinaryDraftSnapshot;
  readonly stage: Pick<StagedSandbox, "target" | "clientRequestId">;
  readonly epicId: string;
  readonly chatId: string | null;
  readonly settings: ChatRunSettings;
}

/** Seal the already captured ordinary row before attachment preparation. */
export function sealStagedSandboxAttempt(
  input: StagedSandboxAttemptInput,
): StagedSandboxAttempt | null {
  const { draft, stage, epicId, chatId, originalHostId } = input;
  if (
    draft.write.target.epicId !== null &&
    draft.write.target.epicId !== epicId
  )
    return null;
  if (draft.write.target.chatId !== chatId) return null;
  if (
    chatId !== null &&
    (stage.target.kind !== "existing" || stage.target.hostId !== originalHostId)
  )
    return null;

  const id = uuidv4();
  return {
    id,
    userId: input.userId,
    originalHostId,
    draft: structuredClone(draft),
    sandbox: structuredClone(stage.target),
    createRequestId:
      stage.target.kind === "new" ? (stage.clientRequestId ?? id) : null,
    firstTurn: {
      epicId,
      chatId: chatId ?? uuidv5(`pending-sandbox-send:${id}:chat`, uuidv5.URL),
      messageId: uuidv5(`pending-sandbox-send:${id}:message`, uuidv5.URL),
      clientActionId: uuidv5(`pending-sandbox-send:${id}:action`, uuidv5.URL),
      settings: structuredClone(input.settings),
    },
  };
}

/** A recovery row keeps the same address as the existing occupied-composer return. */
export function pendingSandboxRecoveryDraftId(id: string): string {
  return uuidv5(`pending-sandbox-send:${id}:recovered`, uuidv5.URL);
}

export interface StagedSandboxReturnIdentity {
  readonly originalDraftId: string;
  readonly draftId: string;
  readonly operationId: string;
}

/** Save this identity with a qualified return before issuing its first placement. */
export function qualifiedStagedSandboxReturnIdentity(
  attempt: StagedSandboxAttempt,
  originalRow: "free" | "occupied-by-newer-draft",
): StagedSandboxReturnIdentity {
  const originalDraftId = attempt.draft.write.draftId;
  const draftId =
    originalRow === "free"
      ? originalDraftId
      : pendingSandboxRecoveryDraftId(attempt.id);
  return {
    originalDraftId,
    draftId,
    operationId: uuidv5(
      JSON.stringify(["pending-sandbox-send", attempt.id, "return", draftId]),
      uuidv5.URL,
    ),
  };
}
