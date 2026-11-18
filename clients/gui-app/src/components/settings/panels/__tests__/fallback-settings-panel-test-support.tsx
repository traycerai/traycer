import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import type { FallbackTabKey } from "@/components/settings/panels/fallback/fallback-tabs";

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

/**
 * Switches the fallback panel to the given tab by clicking its rail trigger.
 *
 * The panel default-mounts on "plan"; Radix `TabsContent` mounts only the
 * active tab's body, so any control on another tab is simply absent from the
 * DOM until this fires. Call it right before the first query that targets a
 * control the target tab holds.
 *
 * `fireEvent.mouseDown`, not `.click`: Radix's `Tabs.Trigger` activates on
 * pointer-down, so a plain click event never fires `onValueChange` here -
 * see the same note on `selectTab` in `providers-settings-panel.test.tsx`.
 *
 * `FallbackPolicyEditor` is keyed on `scope.hostId`, so a host switch remounts
 * it and resets `activeTab` back to the default "plan" - a caller driving that
 * scenario has to call this again after the switch to reopen whichever tab it
 * still needs.
 */
export function openFallbackTab(tab: FallbackTabKey): void {
  fireEvent.mouseDown(screen.getByTestId(`settings-fallback-tab-${tab}`));
}
