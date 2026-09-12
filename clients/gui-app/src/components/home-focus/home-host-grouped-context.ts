import { createContext, useContext } from "react";

/**
 * Whether the rows below are already under a host subheading.
 *
 * A row carries an origin-host pill so a reader can tell where the work is
 * happening; under a heading that says exactly that, the pill is the same fact
 * twice on one line, which is noise. So the heading turns it off.
 *
 * A context rather than a prop because the answer is a property of the SECTION
 * and the rows are several components deep - a prop would be threaded through
 * every row shape, including the ones that have no pill, purely to be passed
 * on. `false` outside a provider, which is both the single-host page and any
 * test that renders a row on its own.
 *
 * A `.ts` module with no component in it: the provider is the context's own,
 * used as `<HomeHostGroupedContext.Provider>` at the one call site, so this
 * file exports a value and a hook and nothing fast-refresh has to reason about.
 */
export const HomeHostGroupedContext = createContext<boolean>(false);

export function useHomeHostGrouped(): boolean {
  return useContext(HomeHostGroupedContext);
}
