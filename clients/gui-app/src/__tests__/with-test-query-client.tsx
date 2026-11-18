import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A `QueryClientProvider` for suites that render a surface reaching TanStack
 * Query - which, since the link bridge became a mutation
 * (`useOpenExternalLink`), is every surface holding a link.
 *
 * Pass it as Testing Library's `wrapper`. One client per mount, retries off,
 * so a failing mutation surfaces its error to the test instead of being
 * retried past the assertion.
 */
export function WithTestQueryClient(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  );
}
