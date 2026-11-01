import { create } from "zustand";
import {
  EMPTY_HOME_BOTS_MODEL,
  type HomeBotsModel,
} from "@/lib/home-bots/bots-model";

interface StandaloneBotsState {
  readonly model: HomeBotsModel;
}

/**
 * The bots model every standalone name reads, so a toast, which renders
 * outside React, agrees with a row or a chip. `StandaloneBotsBridge` is its
 * only writer.
 */
export const useStandaloneBotsStore = create<StandaloneBotsState>(() => ({
  model: EMPTY_HOME_BOTS_MODEL,
}));
