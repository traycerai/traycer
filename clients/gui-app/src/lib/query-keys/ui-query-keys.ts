export const uiQueryKeys = {
  workspaceEntries: (query: string) =>
    ["composer:workspace-entries", query] as const,
  hostPicker: (directoryId: string) => ["host-picker", directoryId] as const,
  hostPickerMissing: () => ["host-picker", "missing"] as const,
  cloudEpicTasksDisabled: () =>
    ["host", "missing", "cloud.listTasks", "disabled"] as const,
  /** One host's update observation - HOST-KEYED, one cache entry per machine. */
  hostUpdateObservation: (hostId: string) =>
    ["host-update-observation", hostId] as const,
};
