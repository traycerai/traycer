import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  renderHook,
  type RenderHookResult,
  type RenderResult,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";

/**
 * A sandbox configuration reads the person's teams and environments through
 * queries, so a surface that resolves one needs a query client above it.
 * These render as `render` and `renderHook` do, over a fresh client with no
 * retries; the client is the render's wrapper, so a `rerender` keeps it.
 */
function clientWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (props) =>
    createElement(QueryClientProvider, { client }, props.children);
}

export function renderWithQueryClient(ui: ReactNode): RenderResult {
  return render(ui, { wrapper: clientWrapper() });
}

export function renderHookWithQueryClient<Result, Props>(
  callback: (props: Props) => Result,
): RenderHookResult<Result, Props> {
  return renderHook(callback, { wrapper: clientWrapper() });
}
