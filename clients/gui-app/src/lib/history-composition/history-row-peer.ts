import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

/** The cloud page and its local contribution can be served by different peers. */
export function historyRowPeerId(
  pagePeerId: string | null,
  servingPeerId: string | null,
  home: "cloud" | "local" | undefined,
): string | null {
  if (pagePeerId !== null && pagePeerId !== POOL_HOST_ID) return pagePeerId;
  if (home === "local")
    return servingPeerId === POOL_HOST_ID ? null : servingPeerId;
  if (home === undefined && pagePeerId === POOL_HOST_ID) return null;
  return pagePeerId;
}
