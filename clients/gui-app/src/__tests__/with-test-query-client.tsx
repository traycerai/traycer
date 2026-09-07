import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * One QueryClient per mount, retries off, so a failing mutation surfaces instead of retrying past the assertion.
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
