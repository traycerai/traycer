import { createContext } from "react";

/**
 * Whether a transcript drawn in the page's flow draws every one of its rows:
 * it has rows and folds none away. `false` outside a flow, and around a
 * header drawn before the flow has rows.
 */
export const BotTranscriptFlowAllShownContext = createContext(false);
