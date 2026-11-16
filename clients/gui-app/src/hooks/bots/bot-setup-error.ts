import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
  SIGN_IN_AGAIN_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { BotSetupFailure } from "@traycer-clients/shared/host-client/bot-setup";

/**
 * A bot write the server did not take, as the error its control states
 * inline, in the words the app's other calls on the person's sign-in use: a
 * refusal in the server's own words, as the secrets calls show authn's.
 */
export function botSetupError(failure: BotSetupFailure): EnvironmentCloudError {
  switch (failure.kind) {
    case "unauthorized":
      return new EnvironmentCloudError(
        "unauthorized",
        SIGN_IN_AGAIN_MESSAGE.settings,
      );
    case "refused":
      return new EnvironmentCloudError("invalid", failure.message);
    case "unavailable":
      return new EnvironmentCloudError(
        "unavailable",
        CLOUD_UNAVAILABLE_MESSAGE,
      );
    case "no_response":
      return new EnvironmentCloudError(
        "no_response",
        NEEDS_CONNECTION_MESSAGE.settings,
      );
  }
}
