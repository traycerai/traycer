export const TEAM_TRANSFER_REFUSALS = [
  {
    code: "E_ENVIRONMENT_NOT_A_MEMBER",
    message: "Join the team before adding this computer.",
  },
  {
    code: "E_ENVIRONMENT_SEAT_NOT_ACCEPTED",
    message: "Accept your team invitation before adding this computer.",
  },
  {
    code: "E_ENVIRONMENT_SEAT_WITHOUT_WRITE",
    message: "Ask a team admin for permission to add computers.",
  },
  {
    code: "E_HOST_IS_SANDBOX",
    message:
      "A sandbox cannot be given to a team. Run this command on the computer you want to add.",
  },
  {
    code: "E_HOST_IN_ANOTHER_TEAM",
    message:
      "Claim this computer from its current team before adding it to another.",
  },
] as const;
