import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// `<BrowserPeekTile>` now renders `BrowserOpenExternalButton`, which reaches
// `useOpenLink()` -> `useOpenExternalLink()` -> `useMutation`, so it needs a
// TanStack Query `QueryClient` in context to render at all. Route every peek
// tile test render through here instead of a bare `render(...)`.
export function renderPeekTile(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper });
}
