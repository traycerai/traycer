import {
  providersListRequestSchema,
  providersListResponseSchema,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-ids";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer profile list [provider]` - every provider profile on this host
 * (the Default account plus any Traycer-managed profiles), optionally
 * filtered to one provider (D23).
 *
 * `providers.list` has no server-side provider filter
 * (`providersListRequestSchema`, `provider-schemas.ts:1785`), so the filter
 * is applied client-side to the one canonical response; the request always
 * fetches the full catalog. Reads the same method the GUI switcher reads, so
 * the CLI can never disagree with it about what profiles exist.
 */
export function buildProfileListCommand(opts: {
  readonly provider: string | null;
}): CommandFn {
  return async () => {
    const providerFilter: ProviderId | null =
      opts.provider === null
        ? null
        : parseUserInput(providerIdSchema, opts.provider);
    const request = parseUserInput(providersListRequestSchema, {
      native: null,
    });
    const result = await toAgentCliError(
      callHostRpc("providers.list", request, null),
    );
    const response = parseCanonicalHostResponse(
      "providers.list",
      providersListResponseSchema,
      result,
    );
    const providers =
      providerFilter === null
        ? response.providers
        : response.providers.filter(
            (provider) => provider.providerId === providerFilter,
          );
    return {
      data: response,
      human: formatProfileList(providers, providerFilter),
      exitCode: 0,
    };
  };
}

function formatProfileList(
  providers: readonly ProviderCliState[],
  providerFilter: ProviderId | null,
): string {
  const rows = providers.flatMap((provider) =>
    orderProfiles(provider.profiles).map((profile) =>
      formatProfileRow(provider.providerId, profile),
    ),
  );
  if (rows.length === 0) {
    return providerFilter === null
      ? "No provider profiles found."
      : `No provider profiles found for provider '${providerFilter}'.`;
  }
  const header =
    "PROVIDER  PROFILE  LABEL  KIND  AUTH  STATUS  ENDPOINT  LAST TEST";
  return [header, ...rows].join("\n");
}

// The Default account (`kind: "ambient"`) prints first within its provider's
// own rows - D26 vocabulary; the sort never reads or emits the wire
// `"ambient"` literal itself.
function orderProfiles(
  profiles: readonly ProviderProfile[],
): readonly ProviderProfile[] {
  return [...profiles].sort((a, b) => {
    if (a.kind === "ambient" && b.kind !== "ambient") return -1;
    if (a.kind !== "ambient" && b.kind === "ambient") return 1;
    return 0;
  });
}

function formatProfileRow(
  providerId: ProviderId,
  profile: ProviderProfile,
): string {
  const isDefaultAccount = profile.kind === "ambient";
  // D26: the wire `"ambient"` sentinel never appears in human output - the
  // Default account's row has no reusable profile id, so the column reads
  // "-" instead of the sentinel a managed profile would show here.
  const profileColumn = isDefaultAccount ? "-" : profile.profileId;
  const kindColumn = isDefaultAccount ? "default account" : "profile";
  const statusColumn = profile.enabled ? "enabled" : "disabled";
  const endpointColumn =
    profile.endpoint === null
      ? "-"
      : `${profile.endpoint.host ?? "-"}/${profile.endpoint.model ?? "-"}`;
  const lastTestColumn = formatLastTest(profile.endpoint?.lastTest ?? null);
  return [
    providerId,
    profileColumn,
    profile.label,
    kindColumn,
    profile.authType,
    statusColumn,
    endpointColumn,
    lastTestColumn,
  ].join("  ");
}

function formatLastTest(
  lastTest: {
    readonly at: number;
    readonly ok: boolean;
    readonly reason: string | null;
  } | null,
): string {
  if (lastTest === null) return "untested";
  const timestamp = new Date(lastTest.at).toISOString();
  if (lastTest.ok) return `ok@${timestamp}`;
  return lastTest.reason === null
    ? `failed@${timestamp}`
    : `failed@${timestamp}: ${lastTest.reason}`;
}
