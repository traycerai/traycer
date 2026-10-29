import { createContext } from "react";
import type {
  BotInputNeeded,
  BotSurfaceActionState,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotSurfaceActRequest,
  BotSurfaceActResponse,
} from "@traycer/protocol/host/bot/surface-schemas";

/**
 * What a bot's channel gives the card under a surface post (Tracy Bots T89):
 * the task's open surfaces and the viewer's own actions in flight, from the
 * bot's subscription; how it names members; and how it sends an answer or a
 * decision. Provided by the channel view around the channel and its thread
 * panel; outside one (the bot's own sessions) a surface post draws its text
 * alone.
 */
export interface BotSurfaceCards {
  readonly botId: string;
  readonly viewerUserId: string | null;
  readonly memberName: (userId: string) => string;
  /**
   * The open surfaces of one task; `null` where the serving host cannot say
   * (it predates them, or cannot read the room), and the card shows Open.
   */
  readonly openSurfaces: (
    taskId: string,
  ) => ReadonlyArray<BotInputNeeded> | null;
  /** The serving host's state of one of the viewer's forwarded actions; `null` when it holds none. */
  readonly hostAction: (actionId: string) => BotSurfaceActionState | null;
  /**
   * Sends an answer or a decision through the tab's host; `null` where that
   * host takes none, and the card offers Open alone.
   */
  readonly act:
    | ((request: BotSurfaceActRequest) => Promise<BotSurfaceActResponse>)
    | null;
}

export const BotSurfaceCardsContext = createContext<BotSurfaceCards | null>(
  null,
);
