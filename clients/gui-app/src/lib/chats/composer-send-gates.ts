import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Whether a message can be sent to a chat now, as one answer for both of the
 * composer's paths: the live submit and the deferred restart confirm. What goes
 * into it comes from the live composer, because its inputs (a disabled profile,
 * a run still preparing, a workspace the host cannot find, signed out) are the
 * results of hooks only a mounted composer holds.
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
