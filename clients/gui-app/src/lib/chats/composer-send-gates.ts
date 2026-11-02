import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";

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
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
  /** A send here wakes the chat's sandbox first, and only {@link submit} can. */
  readonly restingSandbox: boolean;
  /** That sandbox can't be woken, whoever asks. */
  readonly sandboxFrozen: boolean;
  /** What the composer's own send hands over, leaving its draft alone. */
  readonly submit: (input: ChatComposerSubmitInput) => boolean;
  /** Read when sending: the toolbar moves without a render of this state. */
  readonly modelSlug: () => string;
  readonly runSettings: () => ChatRunSettings;
}

const composersBySurface = new Map<string, ComposerSendState>();

function surfaceKey(
  hostId: string,
  chatId: string,
  tileInstanceId: string,
): string {
  return JSON.stringify([hostId, chatId, tileInstanceId]);
}

/** Publishes a composer's state for its tile until the returned call removes it. */
export function publishComposerSendState(
  hostId: string,
  chatId: string,
  tileInstanceId: string,
  state: ComposerSendState,
): () => void {
  const key = surfaceKey(hostId, chatId, tileInstanceId);
  composersBySurface.set(key, state);
  return () => {
    composersBySurface.delete(key);
  };
}

/**
 * The composer of this tile, or `null` with none mounted there. Never another
 * tile's: a split can show one chat twice, each pane with its own settings and
 * its own answer.
 */
export function composerSendStateFor(
  hostId: string,
  chatId: string,
  tileInstanceId: string,
): ComposerSendState | null {
  return (
    composersBySurface.get(surfaceKey(hostId, chatId, tileInstanceId)) ?? null
  );
}
