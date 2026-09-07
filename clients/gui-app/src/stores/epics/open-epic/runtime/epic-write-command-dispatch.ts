/** One epic write command, dispatched on this session's unary requester. */
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { EpicWriteCommandIntent } from "./epic-write-command";
import { EpicWriteCommandTransportUnavailableError } from "./epic-write-command";

export interface EpicWriteCommandDispatchOptions {
  readonly epicId: string;
  /**
   * Read LIVE, never captured: the session's requester can be replaced when the window re-points,
   * and a captured one would send this epic's writes to a host that no longer owns the stream.
   */
  readonly requester: () => HostRequester<HostRpcRegistry> | null;
}

export function dispatchEpicWriteCommand(
  options: EpicWriteCommandDispatchOptions,
  commandId: string,
  intent: EpicWriteCommandIntent,
): Promise<{ readonly hostId: string }> {
  const requester = options.requester();
  const hostId = requester?.getActiveHostId() ?? null;
  if (requester === null || hostId === null) {
    return Promise.reject(new EpicWriteCommandTransportUnavailableError());
  }
  return send(options.epicId, requester, commandId, intent).then(() => ({
    hostId,
  }));
}

async function send(
  epicId: string,
  requester: HostRequester<HostRpcRegistry>,
  commandId: string,
  intent: EpicWriteCommandIntent,
): Promise<void> {
  switch (intent.kind) {
    case "rename-artifact":
      await requester.requestWithIdempotencyKey(
        "epic.renameArtifact",
        { epicId, artifactId: intent.artifactId, title: intent.title },
        commandId,
      );
      return;
    case "delete-artifact":
      await requester.requestWithIdempotencyKey(
        "epic.deleteArtifact",
        { epicId, artifactId: intent.artifactId },
        commandId,
      );
      return;
    case "reparent-artifact":
      await requester.requestWithIdempotencyKey(
        "epic.reparentArtifact",
        {
          epicId,
          artifactId: intent.artifactId,
          newParentId: intent.parentId,
        },
        commandId,
      );
      return;
    case "update-artifact-status":
      await requester.requestWithIdempotencyKey(
        "epic.updateArtifactStatus",
        {
          epicId,
          artifactId: intent.artifactId,
          artifactType: intent.artifactType,
          status: intent.status,
        },
        commandId,
      );
      return;
    case "update-epic-title":
      await requester.requestWithIdempotencyKey(
        "epic.updateTitle",
        {
          epicDelta: {
            id: epicId,
            title: intent.title,
            updatedAt: intent.updatedAt,
          },
        },
        commandId,
      );
      return;
  }
}
