export const agentMutationKeys = {
  startTerminalSession: () => ["agent.tui.prepareLaunch"] as const,
  stop: () => ["agent.stop"] as const,
  setGlobalSelectionGuide: () => ["agent.selectionGuide.setGlobal"] as const,
  resetGlobalSelectionGuide: () =>
    ["agent.selectionGuide.resetGlobalToDefault"] as const,
};
