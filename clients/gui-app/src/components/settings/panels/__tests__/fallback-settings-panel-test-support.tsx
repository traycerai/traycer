import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";

function makeWrapper(client: QueryClient) {
  return ({ children }: { readonly children: ReactNode }): ReactElement =>
    createElement(QueryClientProvider, { client }, children);
}

/** Create isolated query state for each render; RTL keeps it across rerenders. */
export function renderWithFallbackQueryClient(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return render(ui, { wrapper: makeWrapper(queryClient) });
}
