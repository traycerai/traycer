import { createContext } from "react";

const NO_TERMS: readonly string[] = [];

/**
 * The PR panel's active search terms (`prSearchTerms`), read by each row's
 * title to highlight what matched. A context rather than a `PrRow` prop
 * because only the title band reads it, and every other surface that draws a
 * row has no search. Its own module because a component file that also
 * exports a context breaks fast refresh.
 */
export const PrSearchTermsContext = createContext<readonly string[]>(NO_TERMS);
