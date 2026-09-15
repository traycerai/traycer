import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { resolveDesktopMenuPopupBridge } from "@/lib/windows/desktop-capabilities";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import type {
  DesktopMenuPopupBridge,
  DesktopMenuSnapshot,
} from "@/lib/windows/types";

const scopes = new WeakMap<object, number>();
let nextScope = 0;

function menuBridgeQueryScopeId(
  menu: DesktopMenuPopupBridge | null,
): number | null {
  if (menu === null) return null;
  const existing = scopes.get(menu);
  if (existing !== undefined) return existing;
  const scope = ++nextScope;
  scopes.set(menu, scope);
  return scope;
}

export function useDesktopMenu() {
  const host = useRunnerHostOrNull();
  const menu = host === null ? null : resolveDesktopMenuPopupBridge(host);
  const snapshot = useQuery(
    queryOptions<DesktopMenuSnapshot>({
      queryKey: runnerQueryKeys.applicationMenu(menuBridgeQueryScopeId(menu)),
      queryFn: async () =>
        menu === null ? { revision: 0, menus: [] } : menu.getSnapshot(),
      enabled: menu !== null,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
    }),
  );
  const execute = useMutation({
    mutationKey: runnerMutationKeys.executeMenuItem(),
    mutationFn: async ({
      revision,
      itemId,
    }: {
      readonly revision: number;
      readonly itemId: string;
    }) => {
      await menu?.executeItem(revision, itemId);
    },
    onError: (error: Error) =>
      toastFromRunnerError(error, "Couldn't run the application menu action"),
  });
  return { snapshot, execute };
}
