export const notificationsMutationKeys = {
  activate: () => ["notifications.activate"] as const,
  markRead: () => ["notifications.markRead"] as const,
  markEntityRead: () => ["notifications.markEntityRead"] as const,
  markAllRead: () => ["notifications.markAllRead"] as const,
  loadMore: () => ["notifications.loadMore"] as const,
  loadMoreAttention: () => ["notifications.loadMoreAttention"] as const,
  loadMoreUnreadRecent: () => ["notifications.loadMoreUnreadRecent"] as const,
  setConfig: () => ["host.notifications.setConfig"] as const,
  testHook: () => ["host.notificationHooks.test"] as const,
  saveHooks: () => ["host.notificationHooks.save"] as const,
};
