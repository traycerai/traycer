import { createContext, use, useEffect } from "react";
import type { TileFindAdapter } from "@/stores/tile-find";

export interface TileFindContextValue {
  readonly tileInstanceId: string;
  readonly registerAdapter: (adapter: TileFindAdapter) => () => void;
}

export const TileFindContext = createContext<TileFindContextValue | null>(null);

export function useRegisterTileFindAdapter(adapter: TileFindAdapter): void {
  const context = use(TileFindContext);
  useEffect(() => {
    if (context === null) return undefined;
    return context.registerAdapter(adapter);
  }, [adapter, context]);
}
