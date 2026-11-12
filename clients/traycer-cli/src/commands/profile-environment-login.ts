import type {
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import {
  HostRpcError,
  HostTransportFailureError,
  mayHaveReachedHost,
} from "../../../shared/host-transport/host-messenger";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
  installedEnvironmentProfile,
} from "../../../shared/providers/environment-profile-sign-in";
import {
  callHostRpcWithDispatch,
  PLAIN_DISPATCH,
  readLocalHostMethodVersion,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import { printable, readProviderInventory } from "../internal/profile-target";
import { httpUrlOf } from "../internal/profile-login-url";
import { nameNewProfile } from "../internal/profile-login-name";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { CommandContext } from "../runner/runner";
import type {
  ProfileLoginIo,
  ResolvedTarget,
  LoginOutcome,
} from "./profile-login";
import { buildProfileListCommand, summarizeProfile } from "./profile-list";

/** A connected account may keep arriving after the command stops waiting. */
const RECEIVING_WAIT_MS = 60_000;

/** A terminal drives the same environment attempt as the app. The one-time
 * code stays in this stack, outside caches, diagnostics and progress. */
export async function runEnvironmentProfileLogin(
  ctx: CommandContext,
  io: ProfileLoginIo,
  providerId: ProviderId,
  target: ResolvedTarget,
  state: ProviderCliState,
): Promise<LoginOutcome> {
  const binding = await callHostRpcWithDispatch(
    "environment.host.read",
    {},
    PLAIN_DISPATCH,
  );
  const environmentId = binding.environment.environmentId;
  const local: ProviderProfile | undefined = state.profiles.find(
    (profile) => profile.profileId === target.profileId,
  );
  const profileId = local?.environmentProfileId ?? target.profileId;
  const abort = new AbortController();
  // A second Ctrl+C can exit while a late response or release is pending.
  const interrupt = (): void => {
    abort.abort();
    stopInterrupt();
  };
  const stopInterrupt = io.onInterrupt(interrupt);
  let linkId: string | null = null;
  let connectedAt: number | null = null;
  let cancelSent = false;
  const dispatch = (
    method: "providers.link" | "providers.linkComplete",
  ): HostRpcDispatch => ({
    ...PLAIN_DISPATCH,
    reauthenticate: method === "providers.link" ? "before-request" : "always",
    requiredHostMethodVersion: { method, version: { major: 1, minor: 2 } },
  });
  const release = async (): Promise<void> => {
    if (linkId === null || connectedAt !== null || cancelSent) return;
    cancelSent = true;
    try {
      const version = await readLocalHostMethodVersion("providers.linkCancel");
      if (version === null) return;
      const bound = new AbortController();
      await Promise.race([
        callHostRpcWithDispatch(
          "providers.linkCancel",
          { linkId, environmentId },
          { ...PLAIN_DISPATCH, failFast: true, signal: bound.signal },
        ).catch(() => undefined),
        io.wait(3_000, bound.signal),
      ]);
      bound.abort();
    } catch {
      /* An abandoned sign-in is done even if the host is gone. */
    }
  };
  try {
    let replaceAccount = false;
    for (;;) {
      if (abort.signal.aborted) return { status: "cancelled" };
      let start: ProvidersLinkResponseV12;
      try {
        start = await callHostRpcWithDispatch(
          "providers.link",
          {
            providerId,
            profileId,
            environmentId,
            createProfile:
              target.create === null
                ? null
                : {
                    label: target.create.label ?? "New profile",
                    shareSkillsAndPlugins: false,
                  },
            replaceAccount,
          },
          dispatch("providers.link"),
        );
      } catch (error) {
        if (mayHaveReachedHost(error))
          await reportUnknownSignIn(ctx, providerId);
        if (
          !(error instanceof HostRpcError) ||
          error.code !== "harness_account_unidentified" ||
          replaceAccount ||
          abort.signal.aborted
        )
          throw error;
        if (
          !(await confirmAccountSwitch(
            ctx,
            io,
            abort.signal,
            ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
          ))
        )
          return {
            status: "not-started",
            message: ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
          };
        replaceAccount = true;
        continue;
      }
      linkId = start.linkId;
      if (abort.signal.aborted) return { status: "cancelled" };
      const prompt = start.prompt;
      let code: string | null = null;
      if (prompt.kind !== "local_handoff") {
        const rawUrl =
          prompt.kind === "device_code" ? prompt.verificationUrl : prompt.url;
        const url = httpUrlOf(rawUrl);
        if (url === null)
          return {
            status: "not-started",
            message: "The sign-in page could not be opened.",
          };
        ctx.output.humanRequired(
          `To sign in, open this URL in a browser:\n  ${printable(url)}`,
        );
        io.openUrl(url);
        if (prompt.kind === "device_code")
          ctx.output.humanRequired(
            `Enter this code:\n  ${printable(prompt.userCode)}`,
          );
        else {
          ctx.output.humanRequired(
            "Sign in on claude.ai, then paste the code it shows and press Enter.",
          );
          code = await readLine(io, abort.signal, false);
          if (code === null) return { status: "cancelled" };
        }
      }
      for (;;) {
        if (abort.signal.aborted)
          return {
            status: connectedAt !== null ? "signed-in-pending" : "cancelled",
          };
        if (
          connectedAt !== null &&
          Date.now() - connectedAt >= RECEIVING_WAIT_MS
        )
          return { status: "signed-in-pending" };
        let response: ProvidersLinkCompleteResponseV12;
        try {
          response = await callHostRpcWithDispatch(
            "providers.linkComplete",
            { linkId, environmentId, code },
            dispatch("providers.linkComplete"),
          );
        } catch (error) {
          if (
            connectedAt === null &&
            (mayHaveReachedHost(error) ||
              (error instanceof HostRpcError &&
                !(error instanceof HostTransportFailureError) &&
                (error.code === "RPC_ERROR" ||
                  error.code === "PROVIDER_LINK_UNAVAILABLE" ||
                  error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN" ||
                  error.code === "E_IDEMPOTENCY_REPLAY_TOO_LARGE")))
          )
            await reportUnknownSignIn(ctx, providerId);
          if (connectedAt === null) throw error;
          await io.wait(2_000, abort.signal);
          continue;
        }
        code = null;
        if (connectedAt === null && response.state === "unavailable")
          await reportUnknownSignIn(ctx, providerId);
        if (
          connectedAt === null &&
          (response.state === "linked" || response.state === "installing")
        )
          connectedAt = Date.now();
        if (abort.signal.aborted)
          return {
            status: connectedAt !== null ? "signed-in-pending" : "cancelled",
          };
        if (
          connectedAt !== null &&
          response.state !== "linked" &&
          response.state !== "installing"
        ) {
          if (response.state === "expired")
            return { status: "signed-in-pending" };
          await io.wait(2_000, abort.signal);
          continue;
        }
        if (response.state === "linked" || response.state === "installing") {
          if (
            target.profileId !== null &&
            (response.state !== "linked" || response.profileId === null)
          ) {
            await io.wait(2_000, abort.signal);
            continue;
          }
          ctx.output.humanRequired(
            "Waiting for this profile on this computer…",
          );
          let installed: ProviderProfile | null = null;
          try {
            installed = installedEnvironmentProfile(
              (await readProviderInventory()).providers,
              providerId,
              response.environmentProfileId ?? start.environmentProfileId,
              response.profileId,
            );
          } catch {
            /* The connection is established; its inventory may arrive later. */
          }
          if (installed !== null && installed.auth.status === "authenticated") {
            const profile = summarizeProfile(installed);
            return {
              status: "signed-in",
              profile:
                target.create !== null &&
                start.environmentProfileId !== null &&
                installed.environmentProfileId === start.environmentProfileId &&
                !state.profiles.some(
                  (prior) => prior.profileId === installed.profileId,
                )
                  ? await nameNewProfile(
                      providerId,
                      profile,
                      target.create.label,
                    )
                  : profile,
              created: target.create !== null,
            };
          }
          if (abort.signal.aborted) return { status: "signed-in-pending" };
          if (response.state === "linked" && response.profileId !== null)
            return { status: "signed-in-pending" };
          await io.wait(2_000, abort.signal);
          continue;
        }

        if (
          response.code === "harness_account_mismatch" ||
          response.code === "harness_account_unidentified" ||
          response.state === "mismatch"
        ) {
          const line =
            response.code === "harness_account_unidentified"
              ? ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE
              : ACCOUNT_MISMATCH_SIGN_IN_LINE;
          if (!(await confirmAccountSwitch(ctx, io, abort.signal, line)))
            return { status: "not-started", message: line };
          await release();
          linkId = null;
          cancelSent = false;
          replaceAccount = true;
          break;
        }
        if (response.code === "no_sign_in")
          return {
            status: "not-started",
            message: "Sign in on this computer first, then try again.",
          };
        if (response.state !== "pending") return { status: "not-completed" };
        if (
          response.code === "harness_token_shape" &&
          prompt.kind === "sign_in_url"
        ) {
          ctx.output.humanRequired("Paste the whole code claude.ai shows.");
          code = await readLine(io, abort.signal, false);
          if (code === null) return { status: "cancelled" };
        } else await io.wait(2_000, abort.signal);
      }
    }
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN
    )
      throw error;
    if (abort.signal.aborted)
      return {
        status: connectedAt !== null ? "signed-in-pending" : "cancelled",
      };
    throw error;
  } finally {
    stopInterrupt();
    await release();
  }
}

async function reportUnknownSignIn(
  ctx: CommandContext,
  providerId: ProviderId,
): Promise<never> {
  try {
    const inventory = await buildProfileListCommand({ provider: providerId })(
      ctx,
    );
    if (inventory.human !== null) ctx.output.humanRequired(inventory.human);
  } catch {
    /* An unavailable inventory cannot settle the sent sign-in. */
  }
  throw cliError({
    code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
    message:
      "Sign-in may have completed. Check this profile before trying again.",
    details: null,
    exitCode: 1,
  });
}

async function confirmAccountSwitch(
  ctx: CommandContext,
  io: ProfileLoginIo,
  signal: AbortSignal,
  line: string,
): Promise<boolean> {
  ctx.output.humanRequired(line);
  if (!io.stdinIsTerminal()) return false;
  ctx.output.humanRequired(
    `${REPLACE_PROFILE_ACCOUNT_LINE}\nSwitch account? [y/N]`,
  );
  const answer = await readLine(io, signal, true);
  return answer !== null && /^y(es)?$/i.test(answer);
}

function readLine(
  io: ProfileLoginIo,
  signal: AbortSignal,
  acceptEmpty: boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let stopReading: (() => void) | null = null;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      stopReading?.();
      resolve(value);
    };
    const cancel = (): void => finish(null);
    signal.addEventListener("abort", cancel, { once: true });
    stopReading = io.readLines((line) => {
      const value = line.trim();
      if (acceptEmpty || value.length > 0) finish(value);
    }, cancel);
    if (settled) stopReading?.();
    else if (stopReading === null) finish(null);
  });
}
