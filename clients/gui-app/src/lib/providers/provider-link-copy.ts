import type {
  ProvidersLinkCompleteResponse,
  ProvidersLinkResponse,
} from "@traycer/protocol/host/environment-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * The Link dialog's states and lines: one place for the copy, so each state's
 * words are pinned by a test. The account names in these lines are the person's
 * own, shown in their own window.
 */

export const LINK_INTRO =
  "This signs Traycer in to your plan once. It will be offered on every host and sandbox you use; it counts as a device on your plan.";
export const LINK_SIGN_IN_LINE =
  "Sign in on claude.ai, then paste the code it shows.";
export const LINK_DEVICE_LINE =
  "Open the page below and enter this code to sign in.";
export const LINK_LINKING = "Linking…";
export const LINK_UNAVAILABLE = "Connect to Traycer to link this profile.";
export const LINK_EXPIRED = "This sign-in expired.";
export const LINK_FAILED = "Couldn't link this profile.";
export const LINK_PASTE_WHOLE_CODE = "Paste the whole code claude.ai shows.";
export const LINK_NO_SIGN_IN =
  "Sign in to this profile on this computer first, then link it.";

export function onHostOnlyLine(hostName: string): string {
  return `On ${hostName} only.`;
}

export function linkedLine(account: string | null): string {
  return account === null ? "Linked." : `Linked as ${account}.`;
}

export function mismatchLine(
  account: string | null,
  expectedAccount: string | null,
): string {
  if (account === null || expectedAccount === null) {
    return "You signed in to a different account.";
  }
  return `You signed in as ${account}, not ${expectedAccount}.`;
}

/** Where the dialog is: each state renders its own line and actions. */
export type LinkDialogState =
  | { readonly kind: "intro" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "sign_in";
      readonly linkId: string;
      readonly url: string;
      readonly codePrompt: string;
      /** A line under the code box: the last paste was not the whole code. */
      readonly note: string | null;
    }
  | {
      readonly kind: "device";
      readonly linkId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    }
  | { readonly kind: "linking"; readonly linkId: string }
  | { readonly kind: "linked"; readonly account: string | null }
  | {
      readonly kind: "mismatch";
      readonly account: string | null;
      readonly expectedAccount: string | null;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly line: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_offered" };

/** `providers.link`'s answer as the dialog's next state. */
export function stateOfLinkStart(
  response: ProvidersLinkResponse,
): LinkDialogState {
  const { prompt } = response;
  switch (prompt.kind) {
    case "sign_in_url":
      return {
        kind: "sign_in",
        linkId: response.linkId,
        url: prompt.url,
        codePrompt: prompt.codePrompt ?? "Code",
        note: null,
      };
    case "device_code":
      return {
        kind: "device",
        linkId: response.linkId,
        verificationUrl: prompt.verificationUrl,
        userCode: prompt.userCode,
      };
    case "local_handoff":
      return { kind: "linking", linkId: response.linkId };
  }
}

/** `providers.link`'s refusal as the dialog's state. */
export function stateOfLinkError(error: unknown): LinkDialogState {
  if (error instanceof HostRpcError) {
    if (error.code === "PROVIDER_LINK_NOT_OFFERED") {
      return { kind: "not_offered" };
    }
    if (error.code === "PROVIDER_LINK_UNAVAILABLE") {
      return { kind: "unavailable" };
    }
  }
  return {
    kind: "failed",
    line:
      error instanceof Error && error.message.length > 0
        ? error.message
        : LINK_FAILED,
  };
}

/**
 * `providers.linkComplete`'s answer as the dialog's next state; `current`
 * is kept while the link is still pending.
 */
export function stateOfLinkComplete(
  current: LinkDialogState,
  response: ProvidersLinkCompleteResponse,
): LinkDialogState {
  switch (response.state) {
    case "linked":
      return { kind: "linked", account: response.account };
    case "mismatch":
      return {
        kind: "mismatch",
        account: response.account,
        expectedAccount: response.expectedAccount,
      };
    case "expired":
      return { kind: "expired" };
    case "unavailable":
      return { kind: "unavailable" };
    case "pending":
      if (current.kind === "sign_in") {
        return {
          ...current,
          note:
            response.code === "harness_token_shape"
              ? LINK_PASTE_WHOLE_CODE
              : null,
        };
      }
      return current;
    default:
      return {
        kind: "failed",
        line: response.code === "no_sign_in" ? LINK_NO_SIGN_IN : LINK_FAILED,
      };
  }
}
