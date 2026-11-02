import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Whether a message can be sent to a chat now, as one answer for everyone who
 * sends: the composer's Enter and the voice's "tell it". What goes into it comes
 * from the live composer, because its inputs (a disabled profile, a run still
 * preparing, a workspace the host cannot find, signed out) are the results of
 * hooks only a mounted composer holds.
 */

export interface ComposerSendGates {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasPendingApprovals: boolean;
  /** The composer's `resolveSendBlock`, connection and access included. */
  readonly sendDisabled: boolean | undefined;
  readonly workspaceBlocked: boolean;
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
}

export type ComposerSendRefusal =
  | "stopping"
  | "pending-approval"
  | "send-disabled"
  | "workspace-blocked"
  | "images-unsupported"
  | "attachments-preparing";

export function composerSendRefusal(
  gates: ComposerSendGates,
): ComposerSendRefusal | null {
  if (gates.activeTurnStatus === "stopping") return "stopping";
  if (gates.hasPendingApprovals) return "pending-approval";
  if (gates.sendDisabled === true) return "send-disabled";
  if (gates.workspaceBlocked) return "workspace-blocked";
  if (gates.imagesUnsupported) return "images-unsupported";
  if (gates.attachmentPreparationPending) return "attachments-preparing";
  return null;
}

/**
 * An empty slug is the catalog still loading, and it must never reach the wire
 * as `model: ""`.
 */
export function composerModelUnresolved(modelSlug: string): boolean {
  return modelSlug.length === 0;
}

/** What a mounted composer tells a sender that has no composer of its own. */
export interface ComposerSendState {
  readonly sendDisabled: boolean | undefined;
  readonly workspaceBlocked: boolean;
  /** Read when sending: the toolbar moves without a render of this state. */
  readonly modelSlug: () => string;
  readonly runSettings: () => ChatRunSettings;
}

const composersByChat = new Map<string, ReadonlyArray<ComposerSendState>>();

function chatKey(hostId: string, chatId: string): string {
  return JSON.stringify([hostId, chatId]);
}

/** Publishes a composer's state for its chat until the returned call removes it. */
export function publishComposerSendState(
  hostId: string,
  chatId: string,
  state: ComposerSendState,
): () => void {
  const key = chatKey(hostId, chatId);
  composersByChat.set(key, [...(composersByChat.get(key) ?? []), state]);
  return () => {
    const rest = (composersByChat.get(key) ?? []).filter(
      (candidate) => candidate !== state,
    );
    if (rest.length === 0) composersByChat.delete(key);
    else composersByChat.set(key, rest);
  };
}

/** The chat's composer; the newest when a split shows it twice. `null` with none mounted. */
export function composerSendStateFor(
  hostId: string,
  chatId: string,
): ComposerSendState | null {
  return composersByChat.get(chatKey(hostId, chatId))?.at(-1) ?? null;
}
