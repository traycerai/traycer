import { createContext } from "react";

/**
 * Whether a thread panel's box holds its message, the draft kept, because a
 * read beside it says a send would not arrive (`sendWaitsOn`). Only the box
 * waits, as the channel's does: a picked option, an answer, and Retry and
 * Edit on a failed message keep the thread's `sendable` rules. Nothing waits
 * where no read says so.
 */
export const BotThreadBoxWaitsContext = createContext(false);
