import { createContext } from "react";

/**
 * Read by the row's own title band to stand its tooltip down, so one pointer over the row's largest target opens one floating surface rather than two.
 * A context rather than a prop because the decision is made INSIDE `PrRowOwnerHover` - it depends on the epic session handle and on whether any owner still resolves - while the element that has to react to it is that wrapper's own child, built by `PrRow` above it.
 */
export const PrRowHoverCardContext = createContext<boolean>(false);
