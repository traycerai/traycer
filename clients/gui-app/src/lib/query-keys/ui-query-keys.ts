export const uiQueryKeys = {
  workspaceEntries: (query: string) =>
    ["composer:workspace-entries", query] as const,
  hostPicker: (directoryId: string, revision: number) =>
    ["host-picker", directoryId, revision] as const,
  hostPickerMissing: () => ["host-picker", "missing"] as const,
  cloudEpicTasksDisabled: () =>
    ["host", "missing", "cloud.listTasks", "disabled"] as const,
};
