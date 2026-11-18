import { createContext, use, useState, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

const TestRouterChildrenContext = createContext<ReactNode>(null);

// Module-level so it isn't redefined per render (react/no-unstable-nested-
// components). It pulls the subtree from context, which the provider supplies
// above RouterProvider.
function TestRouterRoot(): ReactNode {
  return <>{use(TestRouterChildrenContext)}</>;
}

/**
 * Wraps `children` in a minimal in-memory TanStack Router so components
 * that read router state (for example modal action hooks via the model
 * picker's provider-settings gear) can render in unit tests without the full app
 * route tree. The root route simply renders the passed subtree.
 */
export function TestRouterProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: TestRouterRoot }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  );
  return (
    <TestRouterChildrenContext.Provider value={children}>
      <RouterProvider router={router} />
    </TestRouterChildrenContext.Provider>
  );
}
