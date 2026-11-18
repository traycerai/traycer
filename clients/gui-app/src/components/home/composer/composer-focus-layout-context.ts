import { createContext } from "react";

/**
 * Whether a composer below draws its one-row focus layout: the keyboard is up
 * on a short viewport and this composer holds the focus. Everywhere else, and
 * for the landing composer, it stays `false`.
 */
export const ComposerFocusLayoutContext = createContext(false);
