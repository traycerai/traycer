import { createContext, useContext } from "react";
import type { TracyTranscriptOrigin } from "@/lib/tab-navigation/intents";

/** Provided by `TracyTranscriptOriginScope` around Tracy transcript content only. */
export const TracyTranscriptOriginContext =
  createContext<TracyTranscriptOrigin | null>(null);

/** The transcript a link is drawn in, or `null` outside a Tracy transcript. */
export function useTracyTranscriptOrigin(): TracyTranscriptOrigin | null {
  return useContext(TracyTranscriptOriginContext);
}
