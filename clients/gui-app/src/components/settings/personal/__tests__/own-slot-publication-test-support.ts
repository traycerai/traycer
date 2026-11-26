import { onTestFinished, vi } from "vitest";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import * as addressedEnvironment from "@/hooks/environment/use-addressed-environment";
import * as environmentCloud from "@/hooks/environment/use-environment-cloud";

export const PUBLICATION_ENVIRONMENT_ID = "env-personal";

/** The panel witnesses exercise their bound host and an already-matching Personal row. */
export function installOwnSlotPublicationSignIn(): void {
  const { cloud } = fakeEnvironmentCloud({ status: 503, body: null });
  const signedIn = vi
    .spyOn(environmentCloud, "useEnvironmentCloud")
    .mockReturnValue(() => cloud);
  const personal = vi
    .spyOn(addressedEnvironment, "usePersonalEnvironment")
    .mockReturnValue({
      environmentId: PUBLICATION_ENVIRONMENT_ID,
      resolved: true,
      retry: () => {},
    });
  onTestFinished(() => {
    personal.mockRestore();
    signedIn.mockRestore();
  });
}
