import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

// A projection of authn's binding carrier, not a second host registry.
const teamComputerSchema = z.object({
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
  hostName: z.string().nullable(),
  hostKind: z.enum(["personal", "sandbox"]),
  sharingGeneration: z.number().int().nonnegative(),
  holdsBotSlot: z.boolean().optional().default(false),
  purgePending: z.boolean(),
});
const computersSchema = z.object({ hosts: z.array(teamComputerSchema) });
export type TeamComputer = z.infer<typeof teamComputerSchema>;
export type TeamComputerFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" }
  | { readonly kind: "network-error" };
export type TeamComputersResult =
  | { readonly kind: "ok"; readonly hosts: readonly TeamComputer[] }
  | TeamComputerFailure;
export type SetEnvironmentBotHostResult =
  | { readonly kind: "ok"; readonly host: TeamComputer }
  | TeamComputerFailure;

async function teamComputersRequest(
  authnBaseUrl: string,
  bearer: string,
  environmentId: string,
  input: { readonly hostId: string; readonly sharingGeneration: number } | null,
): Promise<
  { readonly kind: "body"; readonly body: unknown } | TeamComputerFailure
> {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const url = new URL(
    `api/v3/environments/${encodeURIComponent(environmentId)}/${input === null ? "hosts" : "bot-host"}`,
    base,
  );
  if (input === null) url.searchParams.set("include", "binding");
  const abort = composeRequestAbort(null, 10_000);
  try {
    const response = await untilAborted(
      fetch(url.toString(), {
        method: input === null ? "GET" : "PUT",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: input === null ? undefined : JSON.stringify(input),
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status === 404) return { kind: "not-found" };
    if (response.status === 409) return { kind: "conflict" };
    if (response.status !== 200) return { kind: "network-error" };
    const body: unknown = JSON.parse(
      await untilAborted(response.text(), abort.signal),
    );
    return { kind: "body", body };
  } catch {
    return { kind: "network-error" };
  } finally {
    abort.clear();
  }
}

export async function listTeamComputersViaHttp(
  authnBaseUrl: string,
  bearer: string,
  environmentId: string,
): Promise<TeamComputersResult> {
  const result = await teamComputersRequest(
    authnBaseUrl,
    bearer,
    environmentId,
    null,
  );
  if (result.kind !== "body") return result;
  const parsed = computersSchema.safeParse(result.body);
  if (
    !parsed.success ||
    parsed.data.hosts.some((host) => host.environmentId !== environmentId)
  )
    return { kind: "network-error" };
  return { kind: "ok", hosts: parsed.data.hosts };
}

export async function setEnvironmentBotHostViaHttp(
  authnBaseUrl: string,
  bearer: string,
  environmentId: string,
  hostId: string,
  sharingGeneration: number,
): Promise<SetEnvironmentBotHostResult> {
  const result = await teamComputersRequest(
    authnBaseUrl,
    bearer,
    environmentId,
    { hostId, sharingGeneration },
  );
  if (result.kind !== "body") return result;
  const parsed = teamComputerSchema.safeParse(result.body);
  if (
    !parsed.success ||
    parsed.data.hostId !== hostId ||
    parsed.data.environmentId !== environmentId ||
    !parsed.data.holdsBotSlot
  )
    return { kind: "network-error" };
  return { kind: "ok", host: parsed.data };
}
