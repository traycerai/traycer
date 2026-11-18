export const uiQueryKeys = {
  workspaceEntries: (query: string) =>
    ["composer:workspace-entries", query] as const,
  hostPicker: (directoryId: string) => ["host-picker", directoryId] as const,
  hostPickerMissing: () => ["host-picker", "missing"] as const,
  cloudEpicTasksDisabled: () =>
    ["host", "missing", "cloud.listTasks", "disabled"] as const,
  /**
   * One host's update observation — HOST-KEYED, one cache entry per machine.
   *
   * This replaced a single `fleet-update-sweep` key over the joined host list.
   * The fleet-shaped key looked like the cheaper option and was the more
   * expensive one, because a cache entry is also a scheduling unit: one key
   * means one `refetchInterval` for the whole list, so the fastest cadence any
   * host earned was applied to every host. With twenty machines and one
   * ten-minute download, the nineteen quiet hosts were each read about three
   * hundred times instead of about ten — one host's attempt changing every
   * other host's transport cost, on machines whose owners did nothing.
   *
   * Per-host keys make cadence per-host, which is what the rule ("two seconds
   * only while the host itself reports an active operation") always said. The
   * burst bound that the old batched loop provided moves to
   * `fleet-read-gate.ts`, where it applies across the whole fleet rather than
   * within one call.
   *
   * They also make RETENTION per-host: a read that declines keeps that host's
   * previous observation instead of vanishing from a rebuilt map, which is what
   * lets an offline row still say "last seen downloading".
   */
  hostUpdateObservation: (hostId: string) =>
    ["host-update-observation", hostId] as const,
};
