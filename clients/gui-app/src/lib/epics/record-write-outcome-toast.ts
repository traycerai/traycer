import { toast } from "sonner";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

/**
 * What a person is told when an archive or delete of an agent ended as a
 * REQUEST: the host that runs the agent was not reachable, so another host
 * wrote the change to the cloud and the owner finishes it when it is back
 * (`outcome: "requested"`). An `applied` write keeps the app's ordinary
 * behaviour and says nothing here.
 *
 * Only the host the call was sent to knows which branch it took, so these read
 * the response, never where the call was routed.
 */

/**
 * `remove-terminal-agent` is its own kind: a terminal agent's process runs on
 * its host, and a requested delete does not stop it. The answer carries no
 * runtime fact (the agent may already have exited), so the copy says "may".
 */
export type RequestedRecordWrite =
  | "archive"
  | "unarchive"
  | "remove"
  | "remove-terminal-agent";

/**
 * The owner's display name from the live directory, or `null` when the
 * directory has no usable label for it.
 */
export function recordOwnerHostLabel(
  binding: Pick<HostRuntimeBinding<HostRpcRegistry>, "hostClient"> | null,
  ownerHostId: string,
): string | null {
  if (binding === null) return null;
  const label =
    binding.hostClient.resolveHostById(ownerHostId)?.label.trim() ?? "";
  return label.length > 0 ? label : null;
}

export function requestedRecordWriteMessage(
  write: RequestedRecordWrite,
  hostLabel: string | null,
): string {
  switch (write) {
    case "archive":
      return `Archived. ${hostLabel ?? "Its host"} will finish when it is back`;
    case "unarchive":
      return `Unarchived. ${hostLabel ?? "Its host"} will finish when it is back`;
    case "remove":
      return `Removed. Files on ${hostLabel ?? "its host"} are untouched`;
    case "remove-terminal-agent":
      return `Removed. The agent may keep running on ${hostLabel ?? "its host"} until that host reconnects. Its files are untouched`;
  }
}

/**
 * One toast per write kind and owner host: a selection of several agents on
 * the same gone host reads as one line, not a stack of identical ones.
 */
export function toastRequestedRecordWrite(args: {
  readonly write: RequestedRecordWrite;
  readonly ownerHostId: string;
  readonly hostLabel: string | null;
}): void {
  toast.success(requestedRecordWriteMessage(args.write, args.hostLabel), {
    id: `record-write-requested:${args.write}:${args.ownerHostId}`,
  });
}
