import { afterEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import {
  appLocalOpenAuthFor,
  invalidateLocalTeamAdmissionAfterClaim,
} from "../app-local-open-auth";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalTeamAdmissionStore } from "@/stores/host/local-team-admission-store";

const HOST_ID = "claimed-local-host";
const USER_ID = "team-claim-test-user";
const MEMBERSHIP_REQUIRED = {
  code: "TEAM_MEMBERSHIP_REQUIRED",
  reason: "membership required",
  incompatibleMethods: null,
  upgradeGuidance: null,
} as const;

function setSignedInUser(): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: USER_ID, username: USER_ID },
  });
}

function seedAppAdmission(baseUrl: string) {
  const auth = appLocalOpenAuthFor(baseUrl);
  auth.noteSessionGrantRequired(HOST_ID);
  auth.noteRefusal(
    HOST_ID,
    new MutableBearerLease("test-user-bearer", USER_ID),
    MEMBERSHIP_REQUIRED,
  );
  return auth;
}

afterEach(() => {
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("local team admission claim invalidation", () => {
  it("clears app admission evidence and invalidates the submitted native host", async () => {
    setSignedInUser();
    const auth = seedAppAdmission("https://claim-success.authn.invalid");
    expect(auth.requiresSessionGrant(HOST_ID)).toBe(true);
    expect(useLocalTeamAdmissionStore.getState().byHost.get(HOST_ID)).toEqual({
      userId: USER_ID,
      state: "required",
    });

    const invalidateNativeHost = vi.fn((_hostId: string) =>
      Promise.resolve(undefined),
    );
    const runnerHost = createFakeRunnerHost({});
    Object.defineProperty(runnerHost, "hostManagement", {
      value: { invalidateLocalTeamAdmission: invalidateNativeHost },
    });

    await invalidateLocalTeamAdmissionAfterClaim(HOST_ID, runnerHost);

    expect(auth.requiresSessionGrant(HOST_ID)).toBe(false);
    expect(auth.revisionFor(HOST_ID)).toBe(1);
    expect(useLocalTeamAdmissionStore.getState().byHost.has(HOST_ID)).toBe(
      false,
    );
    expect(invalidateNativeHost).toHaveBeenCalledExactlyOnceWith(HOST_ID);
  });

  it("keeps a confirmed claim successful when native invalidation is disconnected", async () => {
    setSignedInUser();
    const auth = seedAppAdmission("https://claim-disconnected.authn.invalid");
    const invalidateNativeHost = vi.fn((_hostId: string) =>
      Promise.reject(new Error("native shell disconnected")),
    );
    const runnerHost = createFakeRunnerHost({});
    Object.defineProperty(runnerHost, "hostManagement", {
      value: { invalidateLocalTeamAdmission: invalidateNativeHost },
    });

    await expect(
      invalidateLocalTeamAdmissionAfterClaim(HOST_ID, runnerHost),
    ).resolves.toBeUndefined();

    expect(auth.requiresSessionGrant(HOST_ID)).toBe(false);
    expect(useLocalTeamAdmissionStore.getState().byHost.has(HOST_ID)).toBe(
      false,
    );
    expect(invalidateNativeHost).toHaveBeenCalledExactlyOnceWith(HOST_ID);
  });
});
