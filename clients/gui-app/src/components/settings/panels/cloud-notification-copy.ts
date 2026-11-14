/** Proposal words from boards C26 and C27, kept together for the owner's ruling. */
export const TEAM_NOTIFICATION_HOOKS_COPY = {
  title: "Notification hooks",
  description: (team: string) =>
    `Each hook is sent from every computer of ${team}. A member's own hooks aren't sent from there.`,
  visibility: (team: string) =>
    `Everyone in ${team} can see each hook's address and headers.`,
  localOnly: (variable: string) =>
    `A team's hook can't read ${variable} from a computer. Type the value itself.`,
  emptyDescription:
    "Hooks send an HTTP request for enabled notification severities.",
  headersExample: "authorization: Bearer your-token",
} as const;

export const ACCOUNT_NOTIFICATIONS_COPY = {
  description:
    "Which events you're told about, and what your automation receives. Choose chimes under Application → Sounds; manage banners in your operating system's notification settings.",
  computerHooks:
    "A hook that runs a script, or reads a value from a computer, is set on that computer.",
  localOnly: (variable: string) =>
    `This hook reads ${variable} from a computer. Set it on that computer.`,
  computerTab: "Notifications",
} as const;
