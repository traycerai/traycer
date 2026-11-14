import {
  isProfileEnabled,
  type ProviderId,
  type ProviderProfile,
  type ProviderProfilePersonNotice,
} from "@traycer/protocol/host/provider-schemas";
import { GUI_HARNESS_BY_PROVIDER_ID } from "../../../shared/providers/provider-harness-ids";
import {
  describeProvider,
  parseProviderArgument,
  printable,
  readProviderStates,
  type ProviderListState,
} from "../internal/profile-target";
import type { CommandFn } from "../runner/runner";

/** Printed in place of the raw sign-in word when the computer sets a notice. */
const PERSON_NOTICE_WORDS: Record<ProviderProfilePersonNotice, string> = {
  "needs-sign-in": "Needs a sign-in",
  waiting: "Waiting for Traycer",
};

/**
 * Under a row whose account is also this computer's Terminal login. The CLI
 * only ever reaches the host on its own computer, so it names no computer.
 */
const TERMINAL_ACCOUNT_LINE = "Terminal account on this computer";

/**
 * The last three keys are present only when the computer says something
 * through them, so the row a computer that predates them answers with is
 * exactly the row it always was.
 */
export interface ProfileListRow {
  readonly profileId: string;
  readonly label: string;
  readonly kind: ProviderProfile["kind"];
  readonly email: string | null;
  readonly enabled: boolean;
  readonly authStatus: ProviderProfile["auth"]["status"];
  readonly rateLimitStatus: ProviderProfile["rateLimitStatus"];
  /** What the person is told in place of `authStatus`. */
  readonly personNotice?: ProviderProfilePersonNotice;
  /**
   * This computer's Terminal login is this row's account. Never on the
   * Terminal login's own row, which is that login.
   */
  readonly terminalOnThisComputer?: true;
  /** The names the account had before it became one row; never empty. */
  readonly otherNames?: readonly string[];
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
    const providers = (await readProviderStates())
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

function summarizeProvider(state: ProviderListState): ProfileListProvider {
  return {
    providerId: state.providerId,
    harnessId: GUI_HARNESS_BY_PROVIDER_ID[state.providerId],
    profiles: state.profiles.map(summarizeProfile),
  };
}

/**
 * The fields a row is built from. Structural, because a `providers.list` row
 * and the profile a mutation response echoes are different types that share
 * these; the echo predates `enabled`, which reads as enabled when absent, and
 * carries none of the list's own keys, which read as nothing to say.
 */
type ProfileSummarySource = Pick<
  ProviderProfile,
  "profileId" | "label" | "kind" | "identity" | "auth" | "rateLimitStatus"
> & {
  readonly enabled?: boolean;
  readonly personNotice?: ProviderProfile["personNotice"];
  readonly terminalOnThisComputer?: boolean;
  readonly otherNames?: readonly string[];
};

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
    ...(profile.personNotice === null || profile.personNotice === undefined
      ? {}
      : { personNotice: profile.personNotice }),
    ...(profile.terminalOnThisComputer === true && profile.kind !== "ambient"
      ? { terminalOnThisComputer: true }
      : {}),
    ...(profile.otherNames === undefined || profile.otherNames.length === 0
      ? {}
      : { otherNames: profile.otherNames }),
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
        ...formatRows(provider.profiles),
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
    row.personNotice === undefined
      ? row.authStatus
      : PERSON_NOTICE_WORDS[row.personNotice],
    row.rateLimitStatus,
  ];
}

/**
 * What the app draws as a second line under the name: each under the row, at
 * the LABEL column, outside the columns' widths.
 */
function detailLinesOf(row: ProfileListRow): string[] {
  return [
    ...(row.terminalOnThisComputer === true ? [TERMINAL_ACCOUNT_LINE] : []),
    ...(row.otherNames === undefined
      ? []
      : [`Also named: ${row.otherNames.map(printable).join(", ")}`]),
  ];
}

function formatRows(profiles: readonly ProfileListRow[]): string[] {
  const cells = profiles.map(cellsOf);
  const widths = COLUMNS.map((_, column) =>
    Math.max(...[COLUMNS, ...cells].map((row) => row[column].length)),
  );
  const line = (row: readonly string[]): string =>
    `  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`.trimEnd();
  const detailIndent = " ".repeat(2 + widths[0] + 2);
  return [
    line(COLUMNS),
    ...profiles.flatMap((profile, index) => [
      line(cells[index]),
      ...detailLinesOf(profile).map((detail) => `${detailIndent}${detail}`),
    ]),
  ];
}
