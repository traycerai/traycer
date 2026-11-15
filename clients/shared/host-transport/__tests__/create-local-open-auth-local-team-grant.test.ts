import { afterEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "../../auth/bearer-source";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
  type LocalSessionGrantProvision,
} from "../local-open-auth";
import { createLocalOpenAuth } from "../create-local-open-auth";

const HOST_ID = "team-local-provision-host";
const AUTHN_BASE_URL = "https://authn.team-local-provision.invalid";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLocalOpenAuth local grant", () => {
  it("treats an attach-grant 404 as terminal membership refusal and a 503 as retryable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "upstream_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const auth = createLocalOpenAuth({
      authnBaseUrl: AUTHN_BASE_URL,
      cloudAuthorized: () => true,
    });
    const bearer = new MutableBearerLease(
      "user-bearer",
      "team-member-test-user",
    );
    const signal = new AbortController().signal;

    const nonmember: LocalSessionGrantProvision = await auth.mint(
      HOST_ID,
      bearer,
      signal,
    );
    expect(nonmember).toMatchObject({
      kind: "refused",
      fatal: {
        code: TEAM_MEMBERSHIP_REQUIRED,
        reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
      },
    });

    const cachedNonmember = await auth.mint(HOST_ID, bearer, signal);
    expect(cachedNonmember).toEqual(nonmember);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const outage: LocalSessionGrantProvision = await auth.mint(
      HOST_ID,
      new MutableBearerLease(
        "another-user-bearer",
        "another-team-member-test-user",
      ),
      signal,
    );
    expect(outage).toMatchObject({
      kind: "unavailable",
      retryCause: { code: TEAM_MEMBERSHIP_UNAVAILABLE, retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
