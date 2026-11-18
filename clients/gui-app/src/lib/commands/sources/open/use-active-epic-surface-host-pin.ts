import {
  useSurfaceHostPinWithDefault,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { selectSoleEpicNodeHostId } from "@/hooks/epic/use-epic-node-host-ids";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";

/** The palette sits outside EpicSessionContext, so name its target task explicitly. */
export function useActiveEpicSurfaceHostPin(
  surfaceKey: string,
  epicId: string | null,
): SurfaceHostPin {
  const projection = useActiveEpicProjection(epicId);
  return useSurfaceHostPinWithDefault(
    surfaceKey,
    projection === null ? null : selectSoleEpicNodeHostId(projection),
  );
}
