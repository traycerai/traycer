export const notificationsMutationKeys = {
  activate: () => ["notifications.activate"] as const,
  markRead: () => ["notifications.markRead"] as const,
  markAllRead: () => ["notifications.markAllRead"] as const,
  loadMore: () => ["notifications.loadMore"] as const,
};
