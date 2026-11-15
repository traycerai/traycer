import { z } from "zod";
import type { ProviderProfileAccentColor } from "@traycer/protocol/host/provider-schemas";
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

export interface ProfileRecordColorChange {
  readonly profileId: string;
  readonly color: ProviderProfileAccentColor;
}

export interface ProfileRecordColorClient {
  setProfileRecordColor(
    environmentId: string,
    harnessId: string,
    change: ProfileRecordColorChange,
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
export function setProfileRecordEnabledViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  harnessId: string,
  profileId: string,
  enabled: boolean,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordEnablementResult> {
  return writeProfileRecordItem({
    authnBaseUrl,
    bearerToken,
    environmentId,
    harnessId,
    profileId,
    patch: { enabled },
    callerSignal,
  });
}

export function setProfileRecordColorViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  harnessId: string,
  change: ProfileRecordColorChange,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordEnablementResult> {
  return writeProfileRecordItem({
    authnBaseUrl,
    bearerToken,
    environmentId,
    harnessId,
    profileId: change.profileId,
    patch: { color: change.color },
    callerSignal,
  });
}

/** Both edits read the exact record's item and preserve every other value. */
async function writeProfileRecordItem(input: {
  readonly authnBaseUrl: string;
  readonly bearerToken: string;
  readonly environmentId: string;
  readonly harnessId: string;
  readonly profileId: string;
  readonly patch:
    | { readonly enabled: boolean }
    | { readonly color: ProviderProfileAccentColor };
  readonly callerSignal: AbortSignal | null;
}): Promise<ProfileRecordEnablementResult> {
  const {
    authnBaseUrl,
    bearerToken,
    environmentId,
    harnessId,
    profileId,
    patch,
    callerSignal,
  } = input;
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
          value: { ...value, ...patch },
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
