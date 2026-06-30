import { deleteCredentials } from "../store/credentials";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer logout`. JSON mode emits exactly one terminal
// NDJSON `result` event; human mode prints a single human line.
//
// Both the "credentials cleared" and "no credentials present" outcomes
// are successful no-ops (exit=0). The shape of `data.loggedOut`
// distinguishes which path was taken so scripts can branch on it.
export const logoutCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  const removed = await deleteCredentials();
  return {
    data: { loggedOut: removed },
    human: ctx.runtime.json ? null : removed ? "Logged out." : "Not logged in.",
    exitCode: 0,
  };
};
