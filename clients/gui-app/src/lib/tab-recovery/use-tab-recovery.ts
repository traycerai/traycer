import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { useTabRecoveryHistory } from "./history";
import { reopenClosedTab } from "./reopen";

export function useTabRecovery() {
  const router = useRouter();
  const available = useTabRecoveryHistory(
    (state) => state.ready && state.entries.length > 0,
  );
  const reopen = useCallback(() => {
    return reopenClosedTab(routerAdapterFor(router));
  }, [router]);
  return { available, reopen };
}
