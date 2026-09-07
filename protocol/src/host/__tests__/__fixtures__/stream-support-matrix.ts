import type { ConnectionManifest } from "@traycer/protocol/framework/index";

/**
 * One historically-released, still-supported app/host version's frozen `/stream` `ConnectionManifest` - the per-method `{ major, minor }` canonical it advertised at that version - plus a human-readable label.
 */
export type StreamSupportMatrixEntry = {
  readonly version: string;
  readonly manifest: ConnectionManifest;
};

/**
 * AUTO-GENERATED entries come from `protocol/scripts/snapshot-stream-support-matrix.ts`.
 * Do not hand-edit an entry's `manifest` - regenerate it instead.
 */
export const streamSupportMatrix: readonly StreamSupportMatrixEntry[] = [
  {
    version: "host-v1.0.0",
    manifest: {
      "agent.inbox.subscribe": { major: 1, minor: 0 },
      "chat.subscribe": { major: 1, minor: 0 },
      "epic.subscribe": { major: 1, minor: 0 },
      "git.subscribeStatus": { major: 1, minor: 0 },
      "migration.run": { major: 1, minor: 0 },
      "notifications.subscribe": { major: 1, minor: 0 },
      "speech.dictate": { major: 1, minor: 0 },
      "terminal.subscribe": { major: 1, minor: 0 },
      "worktree.deleteByPath": { major: 1, minor: 0 },
    },
  },
];
