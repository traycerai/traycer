import { createInterface } from "node:readline/promises";
import type {
  ProviderId,
  ProviderProfileAction,
} from "@traycer/protocol/host/provider-schemas";
import {
  callHostRpcWithDispatch,
  toAgentCliError,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import {
  describeProvider,
  isAmbientProfileId,
  parseProfileArgument,
  parseProviderArgument,
} from "../internal/profile-target";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandContext, CommandFn } from "../runner/runner";

/**
 * Rename and remove ride `providers.setEnabled` as its `profileAction`, a
 * field the 2.1 minor added. Below 2.1 the field is stripped and what is left
 * is a plain "enable this provider" - so these calls name the floor, and an
 * older host refuses them before anything is sent.
 */
const PROFILE_ACTION_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.setEnabled",
    version: { major: 2, minor: 1 },
  },
  signal: null,
};

const PLAIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: null,
};

async function applyProfileAction(
  providerId: ProviderId,
  profileAction: ProviderProfileAction,
): Promise<void> {
  await toAgentCliError(
    callHostRpcWithDispatch(
      "providers.setEnabled",
      // `enabled` is the carrier method's own field and is not read when a
      // profile action is present; `true` matches what the GUI sends.
      { providerId, enabled: true, profileAction },
      PROFILE_ACTION_DISPATCH,
    ),
  );
}

/** `traycer profile rename <provider> <profile> <label>`. */
export function buildProfileRenameCommand(opts: {
  readonly provider: string;
  readonly profile: string;
  readonly label: string;
}): CommandFn {
  return async () => {
    const providerId = parseProviderArgument(opts.provider);
    const profileId = parseProfileArgument(opts.profile);
    const label = parseProfileLabel(opts.label);
    await applyProfileAction(providerId, { type: "rename", profileId, label });
    return {
      data: { providerId, profileId, label },
      human: `Renamed ${describeProvider(providerId)} profile ${profileId} to "${label}".`,
      exitCode: 0,
    };
  };
}

/** The label cap both profile label fields carry on the wire. */
const PROFILE_LABEL_MAX_LENGTH = 64;

export function parseProfileLabel(value: string): string {
  const label = value.trim();
  if (label.length === 0 || label.length > PROFILE_LABEL_MAX_LENGTH) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: a profile label is 1 to ${String(PROFILE_LABEL_MAX_LENGTH)} characters.`,
      details: null,
      exitCode: 1,
    });
  }
  return label;
}

/** `traycer profile enable|disable <provider> <profile>`. */
export function buildProfileSetEnabledCommand(opts: {
  readonly provider: string;
  readonly profile: string;
  readonly enabled: boolean;
}): CommandFn {
  return async () => {
    const providerId = parseProviderArgument(opts.provider);
    const profileId = parseProfileArgument(opts.profile);
    const response = await toAgentCliError(
      callHostRpcWithDispatch(
        "providers.setProfileEnabled",
        { providerId, profileId, enabled: opts.enabled },
        PLAIN_DISPATCH,
      ),
    );
    return {
      data: { providerId, profileId, enabled: response.enabled },
      human: `${response.enabled ? "Enabled" : "Disabled"} ${describeProvider(providerId)} profile ${profileId}.`,
      exitCode: 0,
    };
  };
}

/**
 * `traycer profile remove <provider> <profile> [--yes]` - deletes a managed
 * profile and its stored sign-in. The ambient login is the provider's own and
 * is never removed here.
 */
export function buildProfileRemoveCommand(opts: {
  readonly provider: string;
  readonly profile: string;
  readonly yes: boolean;
}): CommandFn {
  return async (ctx) => {
    const providerId = parseProviderArgument(opts.provider);
    const profileId = parseProfileArgument(opts.profile);
    if (isAmbientProfileId(profileId)) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: the ambient profile is the provider's own CLI login and cannot be removed - use 'traycer profile disable' to stop Traycer using it.",
        details: null,
        exitCode: 1,
      });
    }
    if (!opts.yes) {
      await confirmRemoval(ctx, providerId, profileId);
    }
    await applyProfileAction(providerId, { type: "remove", profileId });
    return {
      data: { providerId, profileId, removed: true },
      human: `Removed ${describeProvider(providerId)} profile ${profileId}.`,
      exitCode: 0,
    };
  };
}

async function confirmRemoval(
  ctx: CommandContext,
  providerId: ProviderId,
  profileId: string,
): Promise<void> {
  const canPrompt =
    !ctx.runtime.json &&
    !ctx.runtime.nonInteractive &&
    process.stdin.isTTY === true;
  if (!canPrompt) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: removing a profile deletes its stored sign-in - pass --yes to confirm.",
      details: null,
      exitCode: 1,
    });
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = await prompt
    .question(
      `Remove ${describeProvider(providerId)} profile ${profileId} and its stored sign-in? [y/N] `,
    )
    .finally(() => prompt.close());
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer: profile not removed.",
      details: null,
      exitCode: 1,
    });
  }
}
