import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";

/**
 * Whether a path typed into a composer names a file where its agent reads it:
 * `hostId`, the host that agent runs on, is this machine. Decided by host id
 * alone. A machine whose own id is unknown counts as another machine, so its
 * files are attached rather than typed as paths that might name nothing.
 */
export function useTypedPathsReach(hostId: string | null): boolean {
  const localHostId = useReactiveLocalHostId();
  return hostId !== null && hostId === localHostId;
}
