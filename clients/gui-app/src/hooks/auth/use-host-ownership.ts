import { queryOptions, useQuery } from "@tanstack/react-query";
import { useHostBinding } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { authQueryKeys } from "@/lib/query-keys";

export function useHostOwnership(hostId: string | null, enabled: boolean) {
  const binding = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const auth = binding?.auth ?? null;
  return useQuery(
    queryOptions({
      queryKey: authQueryKeys.hostOwnership(auth, userId, hostId),
      enabled: enabled && auth !== null && userId !== null && hostId !== null,
      retry: false,
      queryFn: async () => {
        if (auth === null || hostId === null || userId === null)
          throw new Error("Sign in to read this computer's ownership.");
        const era = auth.currentAuthEra();
        if (era.identity !== userId)
          throw new Error(
            "The signed-in account changed. Refresh this computer's Overview.",
          );
        const result = await auth.readHostOwnership(hostId, era);
        if (result.kind !== "ok")
          throw new Error(
            "Could not confirm this computer's ownership. Refresh its Overview.",
          );
        return result.host;
      },
    }),
  );
}
