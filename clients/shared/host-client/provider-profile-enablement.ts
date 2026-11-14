import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

export type ProfileRecordEnablementResult =
  | { readonly kind: "ok" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed" };

export interface ProfileRecordEnablementClient {
  setProfileRecordEnabled(
    environmentId: string,
    harnessId: string,
    change: ProfileRecordEnabledChange,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordEnablementResult>;
}

export interface ProfileRecordEnabledChange {
  readonly profileId: string;
  readonly enabled: boolean;
}

const itemsSchema = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      key: z.string(),
      value: z.json(),
      revision: z.number().int().nonnegative(),
    }),
  ),
});

/** A revision-checked edit on the person's session; no retry or local write. */
export async function setProfileRecordEnabledViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  harnessId: string,
  profileId: string,
  enabled: boolean,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordEnablementResult> {
  if (!PATH_ID_PATTERN.test(environmentId)) return { kind: "failed" };
  const abort = composeRequestAbort(callerSignal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const itemsUrl = new URL(
      `api/v3/environments/${encodeURIComponent(environmentId)}/items`,
      base,
    );
    itemsUrl.searchParams.set("kind", "managed_profile");
    const headers = {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const listed = await untilAborted(
      fetch(itemsUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (listed.status === 403) return { kind: "forbidden" };
    if (!listed.ok) return { kind: "failed" };
    const body: unknown = JSON.parse(
      await untilAborted(listed.text(), abort.signal),
    );
    const parsed = itemsSchema.safeParse(body);
    if (!parsed.success) return { kind: "failed" };
    const key = `${harnessId}:${profileId}`;
    const item = parsed.data.items.find(
      (entry) => entry.kind === "managed_profile" && entry.key === key,
    );
    if (item === undefined) return { kind: "conflict" };
    const value = item.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "failed" };
    }
    const written = await untilAborted(
      fetch(new URL(`${itemsUrl.pathname}/managed_profile`, base), {
        method: "PUT",
        headers,
        body: JSON.stringify({
          key,
          os: null,
          value: { ...value, enabled },
          revision: item.revision,
          upload: null,
        }),
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (written.status === 403) return { kind: "forbidden" };
    if (written.status === 409) return { kind: "conflict" };
    return { kind: written.ok ? "ok" : "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    abort.clear();
  }
}
