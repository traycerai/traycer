import {
  isProfileEnabled,
  type ProviderCliState,
  type ProviderId,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { GUI_HARNESS_BY_PROVIDER_ID } from "../../../shared/providers/provider-harness-ids";
import { callHostRpc, toAgentCliError } from "../internal/host-rpc";
import {
  describeProvider,
  parseProviderArgument,
  printable,
} from "../internal/profile-target";
import type { CommandFn } from "../runner/runner";

export interface ProfileListRow {
  readonly profileId: string;
  readonly label: string;
  readonly kind: ProviderProfile["kind"];
  readonly email: string | null;
  readonly enabled: boolean;
  readonly authStatus: ProviderProfile["auth"]["status"];
  readonly rateLimitStatus: ProviderProfile["rateLimitStatus"];
}

export interface ProfileListProvider {
  readonly providerId: ProviderId;
  readonly harnessId: string;
  readonly profiles: readonly ProfileListRow[];
}

/**
 * `traycer profile list [provider]` - the profiles this host holds, as the
 * GUI's provider settings show them: the provider's own CLI login (`ambient`)
 * and each managed profile.
 *
 * With no provider, only providers that have a profile row are listed; a
 * provider without managed profiles reports none by rule, so listing it would
 * print an empty section for most of the catalog. Limit status is the host's
 * cached reading, not a fresh probe.
 */
export function buildProfileListCommand(opts: {
  readonly provider: string | null;
}): CommandFn {
  return async () => {
    const only =
      opts.provider === null ? null : parseProviderArgument(opts.provider);
    const response = await toAgentCliError(
      callHostRpc("providers.list", { native: null }),
    );
    const providers = response.providers
      .filter((state) =>
        only === null ? state.profiles.length > 0 : state.providerId === only,
      )
      .map(summarizeProvider);
    return {
      data: { providers },
      human: formatProfileList(providers, only),
      exitCode: 0,
    };
  };
}

function summarizeProvider(state: ProviderCliState): ProfileListProvider {
  return {
    providerId: state.providerId,
    harnessId: GUI_HARNESS_BY_PROVIDER_ID[state.providerId],
    profiles: state.profiles.map(summarizeProfile),
  };
}

/**
 * The fields a row is built from. Structural, because a `providers.list` row
 * and the profile a mutation response echoes are different types that share
 * these; the echo predates `enabled`, which reads as enabled when absent.
 */
type ProfileSummarySource = Pick<
  ProviderProfile,
  "profileId" | "label" | "kind" | "identity" | "auth" | "rateLimitStatus"
> & { readonly enabled?: boolean };

export function summarizeProfile(
  profile: ProfileSummarySource,
): ProfileListRow {
  return {
    profileId: profile.profileId,
    label: profile.label,
    kind: profile.kind,
    email: profile.identity?.email ?? null,
    enabled: isProfileEnabled(profile),
    authStatus: profile.auth.status,
    rateLimitStatus: profile.rateLimitStatus,
  };
}

const COLUMNS = ["PROFILE", "LABEL", "ACCOUNT", "STATE", "SIGN-IN", "LIMIT"];

function formatProfileList(
  providers: readonly ProfileListProvider[],
  only: ProviderId | null,
): string {
  if (only !== null && providers.every((p) => p.profiles.length === 0)) {
    return `No profiles for ${describeProvider(only)} on this host.`;
  }
  if (providers.length === 0) return "No profiles on this host.";
  return providers
    .map((provider) =>
      [
        describeProvider(provider.providerId),
        ...formatRows([COLUMNS, ...provider.profiles.map(cellsOf)]),
      ].join("\n"),
    )
    .join("\n\n");
}

function cellsOf(row: ProfileListRow): string[] {
  return [
    printable(row.profileId),
    printable(row.label),
    row.email === null ? "-" : printable(row.email),
    row.enabled ? "enabled" : "disabled",
    row.authStatus,
    row.rateLimitStatus,
  ];
}

function formatRows(rows: readonly (readonly string[])[]): string[] {
  const widths = COLUMNS.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column].length)),
  );
  return rows.map((cells) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`.trimEnd(),
  );
}
