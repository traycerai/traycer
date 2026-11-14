import {
  LocalOpenAuth,
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  type LocalTeamAdmissionState,
} from "./local-open-auth";
import { createSandboxAttachGrantProvider } from "./remote/grant-client";

export interface CreateLocalOpenAuthOptions {
  readonly authnBaseUrl: string;
  readonly cloudAuthorized: () => boolean;
  readonly onAdmissionInvalidated?: (hostId: string) => void;
  readonly onAdmissionState?: (
    hostId: string,
    userId: string,
    state: LocalTeamAdmissionState,
  ) => void;
}

/** One mint implementation for both GUI and CLI local admission. */
export function createLocalOpenAuth(
  options: CreateLocalOpenAuthOptions,
): LocalOpenAuth {
  const auth = new LocalOpenAuth({
    onAdmissionState: options.onAdmissionState,
    onAdmissionInvalidated: options.onAdmissionInvalidated,
    mintSessionGrant: async (hostId, bearer, signal) => {
      const grants = createSandboxAttachGrantProvider({
        authnBaseUrl: options.authnBaseUrl,
        hostId,
        purpose: "local",
        signal,
        getBearerToken: () =>
          options.cloudAuthorized() ? bearer.getBearerToken() : null,
      });
      const result = await grants.provider();
      if (result.kind === "refused") {
        return {
          kind: "refused",
          fatal:
            result.fatal.code === TEAM_MEMBERSHIP_REQUIRED
              ? { ...result.fatal, reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE }
              : result.fatal,
        };
      }
      if (result.kind !== "ok")
        return { kind: "unavailable", retryCause: result.retryCause };
      const token = grants.readSessionGrant();
      return token === null ? { kind: "unavailable" } : { kind: "ok", token };
    },
    provisionMember: null,
  });
  return auth;
}
