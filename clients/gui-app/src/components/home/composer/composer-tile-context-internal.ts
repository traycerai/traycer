import { createContext } from "react";

/**
 * The composer's tile identity for hotspot registration - the chat/task id for
 * a chat tile, `"landing"` for the landing composer.
 */
export const ComposerTileIdContext = createContext<string>("landing");
