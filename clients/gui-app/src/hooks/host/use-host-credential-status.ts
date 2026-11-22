import { useHostCredentialStatusStore } from "@/stores/host/host-credential-status-store";

export function useHostCredentialStatus(hostId: string | null) {
  return useHostCredentialStatusStore((state) =>
    hostId === null ? null : (state.reports[hostId] ?? null),
  );
}
