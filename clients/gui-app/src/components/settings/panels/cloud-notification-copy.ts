export const TEAM_NOTIFICATION_HOOKS_COPY = {
  title: "Notification hooks",
  description: (team: string) =>
    `Each hook is sent from every computer of ${team}.`,
  visibility: (team: string) =>
    `Everyone in ${team} can see each hook's address and headers.`,
  localOnly: (variable: string) =>
    `A team's hook can't read ${variable} from a computer. Type the value itself.`,
  headersExample: "authorization: Bearer your-token",
  emptyTitle: "No notification hooks",
} as const;

export const ACCOUNT_NOTIFICATIONS_COPY = {
  description:
    "What your automation receives when a host creates a notification. Choose which kinds interrupt you under Application → Alerts.",
  localOnly: (variable: string) =>
    `This hook reads ${variable} from a computer. Set it on that computer.`,
  computerTab: "Notifications",
} as const;

export const CLOUD_NOTIFICATION_LIST_COPY = {
  deleteTitle: "Delete hook?",
  deleteDescription: (name: string, team: string | null) =>
    team === null
      ? `"${name}" will stop being sent from your computers.`
      : `"${name}" will stop being sent from ${team}'s computers.`,
  emptyState: null,
} as const;
