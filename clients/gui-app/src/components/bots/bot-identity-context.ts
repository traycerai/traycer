import { createContext, useContext } from "react";
import type { EnvironmentMember } from "@traycer/protocol/host/environment/contracts";

/**
 * Who answers for a bot: the person whose personal bot it
 * is, or the team whose bot it is.
 */
export type BotOwner =
  | {
      readonly kind: "person";
      readonly userId: string;
      readonly name: string;
      readonly avatarUrl: string | null;
    }
  | {
      readonly kind: "team";
      readonly name: string;
      /** The team's members as its directory lists them; `null` while unread. */
      readonly members: ReadonlyArray<EnvironmentMember> | null;
    };

/**
 * The bot a surface draws, for its picture and its name's popover: its id
 * (what its colour is hashed from), its current title, and its owner (`null`
 * until the environment list names it).
 */
export interface BotIdentity {
  readonly botId: string;
  readonly title: string;
  readonly owner: BotOwner | null;
}

export const BotIdentityContext = createContext<BotIdentity | null>(null);

/** The bot the surface draws; `null` outside one (a plain bot picture). */
export function useBotIdentity(): BotIdentity | null {
  return useContext(BotIdentityContext);
}

/** Who may message the bot, in the person's words. */
export function botAccessLine(owner: BotOwner): string {
  return owner.kind === "person" ? "Only you" : `Members of ${owner.name}`;
}
