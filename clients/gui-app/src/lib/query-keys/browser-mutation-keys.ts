export const browserMutationKeys = {
  closeTab: (hostId: string, sessionId: string, tabId: string) =>
    ["browser.closeTab", hostId, sessionId, tabId] as const,
};
