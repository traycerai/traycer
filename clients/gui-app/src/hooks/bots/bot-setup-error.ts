import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
  SIGN_IN_AGAIN_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { BotSetupFailure } from "@traycer-clients/shared/host-client/bot-setup";

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
