import { z } from "zod";
import {
  hostOwnerPrincipalSchema,
  hostRegistryKindSchema,
} from "@traycer/protocol/host/host-status";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

const ownershipSchema = z.object({
  hostId: z.string().min(1),
  owner: hostOwnerPrincipalSchema,
  kind: hostRegistryKindSchema,
  remoteAccess: z.boolean(),
});
const ownershipListSchema = z.object({ hosts: z.array(ownershipSchema) });
export type HostOwnership = z.infer<typeof ownershipSchema>;
export type HostOwnershipResult =
  | { readonly kind: "ok"; readonly host: HostOwnership }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

/** Reads ownership even with Remote access off; never makes a host addressable. */
export async function readHostOwnershipViaHttp(
  authnBaseUrl: string,
  bearer: string,
  hostId: string,
): Promise<HostOwnershipResult> {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const url = new URL("api/v3/hosts", base);
  url.searchParams.set("include", "owner,remoteAccess,sandboxState");
  const abort = composeRequestAbort(null, 10_000);
  try {
    const response = await untilAborted(
      fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
        },
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 401 || response.status === 403)
      return { kind: "unauthorized" };
    if (response.status !== 200) return { kind: "network-error" };
    const raw: unknown = JSON.parse(
      await untilAborted(response.text(), abort.signal),
    );
    const parsed = ownershipListSchema.safeParse(raw);
    if (!parsed.success) return { kind: "network-error" };
    const host = parsed.data.hosts.find((row) => row.hostId === hostId);
    return host === undefined ? { kind: "not-found" } : { kind: "ok", host };
  } catch {
    return { kind: "network-error" };
  } finally {
    abort.clear();
  }
}
