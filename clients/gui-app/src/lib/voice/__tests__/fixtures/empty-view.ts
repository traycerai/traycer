import { composeVoiceView, NO_PALETTE_ITEMS } from "../../view";

/** A page with no actions: for routes that are about bots, not the page in front. */
export const EMPTY_VIEW = composeVoiceView({
  page: { kind: "home" },
  agent: null,
  agentAsleep: false,
  agentTurnRunning: false,
  approvals: [],
  palette: NO_PALETTE_ITEMS,
  generation: 0,
});
