import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DraftDocument,
  DraftKind,
  DraftWrite,
} from "@traycer/protocol/host";
import type {
  DraftComposerPortable,
  DraftTarget,
  DraftWorkspaceSnapshot,
} from "@traycer/protocol/persistence/draft/schemas";
import { chatRunSettingsStrictSchema } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  DEFAULT_COMPOSER_MODE,
  isComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { StoredInterviewDraft } from "@/stores/composer/interview-draft-store";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function blobHashesOfWrite(write: DraftWrite): ReadonlyArray<string> {
  if (write.kind === "interview") return [];
  return write.portable.blobHashes;
}

export function blobHashesOfDocument(
  document: DraftDocument,
): ReadonlyArray<string> {
  if (document.kind === "interview") return [];
  return document.portable.blobHashes;
}

export function blobHashesFromContent(
  content: JsonContent,
): ReadonlyArray<string> {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash === null || !SHA256_HEX.test(atom.hash)) continue;
    if (seen.has(atom.hash)) continue;
    seen.add(atom.hash);
    hashes.push(atom.hash);
  }
  return hashes;
}

export function portableComposerFromLocal(input: {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
  readonly runSettings: ChatRunSettings | null;
  readonly composerMode: ComposerMode | null;
  readonly closed: boolean;
}): DraftComposerPortable {
  return {
    content: input.content,
    selection: input.selection,
    runSettings: strictRunSettingsOrNull(input.runSettings),
    composerMode:
      input.composerMode !== null && isComposerMode(input.composerMode)
        ? input.composerMode
        : DEFAULT_COMPOSER_MODE,
    blobHashes: [...blobHashesFromContent(input.content)],
    closed: input.closed,
  };
}

export function strictRunSettingsOrNull(
  settings: ChatRunSettings | null,
): DraftComposerPortable["runSettings"] {
  if (settings === null) return null;
  const parsed = chatRunSettingsStrictSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

export function workspaceSnapshotOrNull(
  workspace: LandingDraftWorkspaceSnapshot | null,
): DraftWorkspaceSnapshot | null {
  if (workspace === null) return null;
  return {
    folders: [...workspace.folders],
    folderInfoByPath: { ...workspace.folderInfoByPath },
    primaryPath: workspace.primaryPath,
  };
}

export function composerDraftWrite(input: {
  readonly draftId: string;
  readonly kind: Extract<DraftKind, "landing" | "new-chat" | "chat-composer">;
  readonly target: DraftTarget;
  readonly revision: number;
  readonly lastTouchedAt: number;
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
  readonly runSettings: ChatRunSettings | null;
  readonly composerMode: ComposerMode | null;
  readonly workspace: LandingDraftWorkspaceSnapshot | null;
  readonly closed: boolean;
  /**
   * Ancestor id on a fork's FIRST write (the row's still-unacknowledged
   * pointer); null on every other write. The session clears the row's
   * pointer on the ACK, so the write plane simply carries what the row has.
   */
  readonly supersedes: string | null;
}): DraftWrite {
  return {
    draftId: input.draftId,
    kind: input.kind,
    target: input.target,
    revision: input.revision,
    lastTouchedAt: input.lastTouchedAt,
    workspace: workspaceSnapshotOrNull(input.workspace),
    supersedes: input.supersedes,
    portable: portableComposerFromLocal({
      content: input.content,
      selection: input.selection,
      runSettings: input.runSettings,
      composerMode: input.composerMode,
      closed: input.closed,
    }),
  };
}

export function interviewDraftWrite(input: {
  readonly draftId: string;
  readonly target: DraftTarget;
  readonly revision: number;
  readonly lastTouchedAt: number;
  readonly draft: StoredInterviewDraft;
}): DraftWrite {
  return {
    draftId: input.draftId,
    kind: "interview",
    target: input.target,
    revision: input.revision,
    lastTouchedAt: input.lastTouchedAt,
    workspace: null,
    // Interview drafts are never forked: they are answered on the chat's
    // own host, so there is no ancestor to retract.
    supersedes: null,
    portable: {
      pageIndex: input.draft.pageIndex,
      // Labels alone are a LEGACY answer, whose settlement must stay
      // neutral - carry the interaction-time evidence too, or a draft
      // silently degrades by crossing the host.
      answers: input.draft.answers.map((answer) => ({
        questionIdentity: answer.questionIdentity,
        selected: [...answer.selected],
        selectedOptionIndices:
          answer.selectedOptionIndices === undefined
            ? undefined
            : [...answer.selectedOptionIndices],
        otherText: answer.otherText,
        otherSelected: answer.otherSelected,
      })),
    },
  };
}

export function requiredChatTarget(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string | null;
}): DraftTarget {
  return {
    epicId: input.epicId,
    chatId: input.chatId,
    blockId: input.blockId,
  };
}

export function landingTarget(): DraftTarget {
  return { epicId: null, chatId: null, blockId: null };
}

export function newChatTarget(epicId: string): DraftTarget {
  return { epicId, chatId: null, blockId: null };
}
