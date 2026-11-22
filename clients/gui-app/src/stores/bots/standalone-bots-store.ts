import { create } from "zustand";
import { EMPTY_HOME_BOTS_MODEL } from "@/lib/home-bots/bots-model";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";

interface StandaloneBotsState {
  readonly directory: StandaloneBotsDirectory;
  /**
   * Whether `directory` is an answer: every read it comes from has answered
   * or failed. Unsettled, an empty directory says nothing about the person's
   * bots.
   */
  readonly settled: boolean;
  /**
   * Whether the directory holds an answer of the bot list itself. Settled
   * also covers a read that failed or ran out of time, and the environments'
   * groups exist before their bots are read, so only this says a bot the
   * directory lacks is gone.
   */
  readonly botsListed: boolean;
}

/**
 * The directory every standalone name reads, so a toast, which renders outside
 * React, agrees with a row or a chip. `StandaloneBotsBridge` is its only
 * writer.
 */
export const useStandaloneBotsStore = create<StandaloneBotsState>(() => ({
  directory: { model: EMPTY_HOME_BOTS_MODEL, setups: [] },
  settled: false,
  botsListed: false,
}));
