import { afterEach, describe, expect, it } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
} from "@traycer-clients/shared/auth/host-token-source";
import {
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
  type HostCredentialMintRunner,
  type HostCredentialMintRunnerOutcome,
} from "@/lib/auth/host-credential-provisioning";
import { localDoorHostTokens } from "../local-door-host-tokens";

const USER_ID = "user-a";
const HOST_ID = "e7f51e2d-8b0b-4ffc-b732-8c3c69c53c5a";

describe("local door host token after the computer's credential wait", () => {
  afterEach(() => {
    setHostCredentialMintRunner(null);
    resetHostCredentialProvisioning();
  });

  it("asks authn for no second mint when the host process was replaced during the credential wait", async () => {
    const hostTokenMints: string[] = [];
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        hostTokenMints.push(hostId);
        const refused: HostTokenMintOutcome = { kind: "not-admitted" };
        return Promise.resolve(refused);
      },
      signIn: () => "sign-in-token",
      now: () => Date.now(),
    });
    let finishCredentialMint: (
      outcome: HostCredentialMintRunnerOutcome,
    ) => void = () => undefined;
    const credentialMint = new Promise<HostCredentialMintRunnerOutcome>(
      (resolve) => {
        finishCredentialMint = resolve;
      },
    );
    let credentialMintStarted = false;
    const runner: HostCredentialMintRunner = () => {
      credentialMintStarted = true;
      return credentialMint;
    };
    setHostCredentialMintRunner(runner);
    let observed = "process-a";
    const door = localDoorHostTokens(hostTokens);

    const answer = door.obtain(USER_ID, HOST_ID, true, {
      signal: null,
      owner: { hostId: HOST_ID, observed: "process-a" },
      observedNow: () => observed,
    });
    await expect.poll(() => credentialMintStarted).toBe(true);
    expect(hostTokenMints).toEqual([HOST_ID]);

    observed = "process-b";
    finishCredentialMint({
      kind: "provisioned",
      token: "host-credential-access",
      refreshToken: "host-credential-refresh",
      familyId: "family-a",
      provisionedAt: "2026-11-14T00:00:00Z",
      expiresIn: 300,
    });

    expect(await answer).toEqual({ kind: "process-replaced" });
    expect(hostTokenMints).toEqual([HOST_ID]);
    expect(hostTokens.current(USER_ID, HOST_ID)).toBeNull();
  });
});
