import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import {
  providersCopySettingsRequestSchema,
  providersPreviewCopySettingsResponseSchema,
  providersApplyCopySettingsResponseSchema,
  copySettingsCategorySchema,
  type CopySettingsCategoryPreview,
  type ProvidersApplyCopySettingsResponse,
  type ProvidersPreviewCopySettingsResponse,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

const ALL_CATEGORIES = copySettingsCategorySchema.options;

/**
 * `traycer profile copy --provider <id> --from <ambient|id> --to <id...>
 * --categories <list>` - D13's one-time "Copy settings" between profiles of
 * the same provider. Always previews first (`providers.previewCopySettings`);
 * mutates (`providers.applyCopySettings`) only with `--yes`, so a bare run
 * changes nothing and exits 0.
 *
 * Targets are managed profiles only - the Default account is never a copy
 * target (D13) - rejected client-side before any RPC, same as `profile
 * remove`'s Default-account guard.
 */
export function buildProfileCopyCommand(opts: {
  readonly provider: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly categories: readonly string[];
  readonly yes: boolean;
}): CommandFn {
  return async (ctx) => {
    const providerId = parseUserInput(providerIdSchema, opts.provider);
    const from = opts.from.trim();
    const source =
      from === AMBIENT_PROFILE_ID_SENTINEL
        ? ({ kind: "defaultAccount" } as const)
        : ({ kind: "profile", profileId: from } as const);
    if (opts.to.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: profile copy requires at least one --to <id>.",
        details: null,
        exitCode: 1,
      });
    }
    if (opts.to.includes(AMBIENT_PROFILE_ID_SENTINEL)) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: the Default account is never a copy target.",
        details: null,
        exitCode: 1,
      });
    }
    const categories =
      opts.categories.length === 0 ? ALL_CATEGORIES : opts.categories;
    const request = parseUserInput(providersCopySettingsRequestSchema, {
      providerId,
      source,
      targets: opts.to,
      categories,
    });

    const previewResult = await toAgentCliError(
      callHostRpc("providers.previewCopySettings", request, null),
    );
    const previewResponse = parseCanonicalHostResponse(
      "providers.previewCopySettings",
      providersPreviewCopySettingsResponseSchema,
      previewResult,
    );
    const previewText = formatPreview(previewResponse);
    if (!opts.yes) {
      return { data: previewResponse, human: previewText, exitCode: 0 };
    }

    ctx.output.humanRequired(previewText);
    const applyResult = await toAgentCliError(
      callHostRpc("providers.applyCopySettings", request, null),
    );
    const applyResponse = parseCanonicalHostResponse(
      "providers.applyCopySettings",
      providersApplyCopySettingsResponseSchema,
      applyResult,
    );
    return {
      data: applyResponse,
      human: formatApplyResults(applyResponse),
      exitCode: applyExitCode(applyResponse),
    };
  };
}

function formatPreview(response: ProvidersPreviewCopySettingsResponse): string {
  return response.targets
    .flatMap((target) => [
      `Target ${target.profileId} (${target.label}):`,
      ...target.categories.map(formatCategoryPreview),
    ])
    .join("\n");
}

function formatCategoryPreview(category: CopySettingsCategoryPreview): string {
  if (category.noop) return `  ${category.category}: no-op (already Linked)`;
  const secretNote = category.carriesSecretValues
    ? " [includes secret values]"
    : "";
  const flipNote =
    category.ownershipFlip === "linkedToOwn" ? " (Linked -> Own)" : "";
  return `  ${category.category}${secretNote}${flipNote}: adds=[${category.adds.join(", ")}] changes=[${category.changes.join(", ")}] removals=[${category.removals.join(", ")}]`;
}

function formatApplyResults(
  response: ProvidersApplyCopySettingsResponse,
): string {
  return response.results
    .map((result) =>
      result.outcome.kind === "copied"
        ? `${result.profileId}: copied`
        : `${result.profileId}: failed: ${result.outcome.reason}`,
    )
    .join("\n");
}

function applyExitCode(response: ProvidersApplyCopySettingsResponse): number {
  return response.results.some((result) => result.outcome.kind === "failed")
    ? 1
    : 0;
}
