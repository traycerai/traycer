import { createContext } from "react";

/**
 * Whether the surrounding PR row has a live hover card that is already heading
 * itself with the PR's full title.
 *
 * Read by the row's own title band to stand its tooltip down, so one pointer
 * over the row's largest target opens one floating surface rather than two.
 *
 * A context rather than a prop because the decision is made INSIDE
 * `PrRowOwnerHover` - it depends on the epic session handle and on whether any
 * owner still resolves - while the element that has to react to it is that
 * wrapper's own child, built by `PrRow` above it. Its own module because a
 * component file that also exports a context breaks fast refresh.
 */
export const PrRowHoverCardContext = createContext<boolean>(false);
