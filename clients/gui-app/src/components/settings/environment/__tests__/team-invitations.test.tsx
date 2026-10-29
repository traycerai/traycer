import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  fetchEnvironmentInvitations,
  acceptEnvironmentInvitation,
} from "@traycer-clients/shared/auth/environment-invitations";
import { InviteAcceptDialog } from "@/components/settings/members/invite-accept-dialog";
import { TeamRows } from "@/components/settings/environment/team-rows";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
  type TeamPageHarness,
} from "./team-configuration-test-support";

const viewerUserId = vi.hoisted(() => ({ current: "user-me" }));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => viewerUserId.current,
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
  resetNegotiatedManifests();
  vi.restoreAllMocks();
  viewerUserId.current = "user-me";
});

const V10 = { major: 1, minor: 0 } as const;

const INVITATION: EnvironmentInvitation = {
  environmentId: "env-beta",
  teamName: "Beta",
  role: "viewer",
  paidPlan: true,
};

const NO_ENVIRONMENTS = { environments: [] };
const AUTHN_BASE_URL = "https://authn.example.test";
const TEST_BEARER = "invitation-test-bearer";

type InvitationAuth = Pick<
  AuthService,
  "listEnvironmentInvitations" | "acceptEnvironmentInvitation"
>;

interface InvitationHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

function invitationAuth(): InvitationAuth {
  return {
    listEnvironmentInvitations: (signal) =>
      fetchEnvironmentInvitations(AUTHN_BASE_URL, TEST_BEARER, signal),
    acceptEnvironmentInvitation: (environmentId) =>
      acceptEnvironmentInvitation(AUTHN_BASE_URL, TEST_BEARER, environmentId),
  };
}

function wrapperWithInvitationAuth(
  wrapper: TeamPageHarness["Wrapper"],
  auth: InvitationAuth,
): TeamPageHarness["Wrapper"] {
  const binding = Object.create(null) as HostRuntimeBinding<HostRpcRegistry>;
  Object.defineProperty(binding, "auth", { value: auth });
  const PageWrapper = wrapper;
  return ({ children }) => (
    <PageWrapper>
      <HostRuntimeContext.Provider value={binding}>
        {children}
      </HostRuntimeContext.Provider>
    </PageWrapper>
  );
}

function stubInvitationHttp(
  invitationsForViewer: (() => readonly EnvironmentInvitation[]) | undefined,
): InvitationHttpCall[] {
  const calls: InvitationHttpCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const method = init?.method ?? "GET";
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const response =
      method === "POST"
        ? { outcome: "accepted" }
        : { invitations: (invitationsForViewer ?? (() => [INVITATION]))() };
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

function rowsElement(onReview: (invitation: EnvironmentInvitation) => void) {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value="personal">
          <TeamRows
            pick={PERSONAL_PICK}
            onPick={() => undefined}
            onReview={onReview}
          />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderRows(onReview: (invitation: EnvironmentInvitation) => void) {
  return (harnessWrapper: TeamPageHarness["Wrapper"]) =>
    render(rowsElement(onReview), { wrapper: harnessWrapper });
}

function InvitationFlow(props: {
  readonly onAccepted: (environmentId: string) => void;
}): ReactNode {
  const [invitation, setInvitation] = useState<EnvironmentInvitation | null>(
    null,
  );
  return (
    <>
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="personal">
            <TeamRows
              pick={PERSONAL_PICK}
              onPick={() => undefined}
              onReview={setInvitation}
            />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <InviteAcceptDialog
        invitation={invitation}
        onClose={() => setInvitation(null)}
        onAccepted={props.onAccepted}
      />
    </>
  );
}

async function assertExplicitHttpInvitationFlow(
  harness: TeamPageHarness,
): Promise<void> {
  const calls = stubInvitationHttp(undefined);
  const onAccepted = vi.fn();
  const wrapper = wrapperWithInvitationAuth(harness.Wrapper, invitationAuth());
  render(<InvitationFlow onAccepted={onAccepted} />, { wrapper });

  const row = await screen.findByTestId("environment-invitation-env-beta");
  expect(row.textContent).toContain("Beta");
  expect(calls.map((call) => call.method)).toEqual(["GET"]);
  expect(calls[0]?.url).toBe(
    `${AUTHN_BASE_URL}/api/v3/environments/me/invitations`,
  );
  expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${TEST_BEARER}`);
  expect(calls[0]?.headers.get("x-traycer-invite-acceptance")).toBe("explicit");

  await userEvent.click(
    screen.getByTestId("environment-invitation-review-env-beta"),
  );
  expect(
    screen.getByRole("heading", { name: "You're invited to Beta" }),
  ).toBeTruthy();
  expect(screen.getByTestId("invite-accept-grant")).toBeTruthy();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  expect(onAccepted).not.toHaveBeenCalled();

  await userEvent.click(screen.getByTestId("invite-accept"));
  await waitFor(() => {
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith("env-beta");
  });
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe(
    `${AUTHN_BASE_URL}/api/v3/environments/me/invitations/accept`,
  );
  expect(posts[0]?.headers.get("Authorization")).toBe(`Bearer ${TEST_BEARER}`);
  expect(posts[0]?.headers.get("x-traycer-invite-acceptance")).toBe("explicit");
  expect(JSON.parse(posts[0]?.body ?? "null")).toEqual({
    environmentId: "env-beta",
  });
  expect(harness.paramsOf("environment.invitations.list")).toHaveLength(0);
  expect(harness.paramsOf("environment.invitations.accept")).toHaveLength(0);
}

describe("the invited rows of the Environment dropdown", () => {
  it("lists an invited team as 'invited' with Review, and hands the invitation to Review", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    const onReview = vi.fn();
    renderRows(onReview)(harness.Wrapper);

    const row = await screen.findByTestId("environment-invitation-env-beta");
    expect(row.textContent).toContain("Beta");
    expect(row.textContent).toContain("invited");
    // The verb continues the row's own line, so the row keeps no gutter for a
    // check it can never show.
    expect(row.className).not.toContain("pr-8");
    await userEvent.click(
      screen.getByTestId("environment-invitation-review-env-beta"),
    );
    expect(onReview).toHaveBeenCalledExactlyOnceWith(INVITATION);
  });

  it("lists and accepts an older-host invitation over authenticated HTTP only after explicit review", async () => {
    negotiateMethods({});
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
      "environment.invitations.accept": () => ({ outcome: "accepted" }),
    });
    await assertExplicitHttpInvitationFlow(harness);
  });

  it("lists and accepts over authenticated HTTP without an active host", async () => {
    resetNegotiatedManifests();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
      "environment.invitations.accept": () => ({ outcome: "accepted" }),
    });
    useSelectionAuthorityStore.getState().reset();
    const requester = requireTeamHostClient();
    teamHostBoundary.client = requester.createRequesterForHostId(null);
    expect(teamHostBoundary.client.getActiveHostId()).toBeNull();

    await assertExplicitHttpInvitationFlow(harness);
  });

  it("waits for an addressable host's invitation capabilities before routing", async () => {
    resetNegotiatedManifests();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
      "environment.invitations.accept": () => ({ outcome: "accepted" }),
    });
    expect(requireTeamHostClient().getActiveHostId()).not.toBeNull();
    const calls = stubInvitationHttp(undefined);
    renderRows(vi.fn())(
      wrapperWithInvitationAuth(harness.Wrapper, invitationAuth()),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.list")).toHaveLength(1);
    });
    expect(screen.queryByTestId("environment-invitation-env-beta")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(harness.paramsOf("environment.invitations.list")).toHaveLength(0);
    expect(harness.paramsOf("environment.invitations.accept")).toHaveLength(0);
  });

  it("does not query or show invitations without an authenticated binding", async () => {
    negotiateMethods({});
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
      "environment.invitations.accept": () => ({ outcome: "accepted" }),
    });
    renderRows(vi.fn())(harness.Wrapper);

    await waitFor(() => {
      expect(harness.paramsOf("environment.list")).toHaveLength(1);
    });
    expect(screen.queryByTestId("environment-invitation-env-beta")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.paramsOf("environment.invitations.list")).toHaveLength(0);
    expect(harness.paramsOf("environment.invitations.accept")).toHaveLength(0);
  });

  it("uses HTTP when list is supported but Accept is not", async () => {
    negotiateMethods({ "environment.invitations.list": V10 });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    const calls = stubInvitationHttp(undefined);
    renderRows(vi.fn())(
      wrapperWithInvitationAuth(harness.Wrapper, invitationAuth()),
    );

    expect(
      await screen.findByTestId("environment-invitation-env-beta"),
    ).toBeTruthy();
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(harness.paramsOf("environment.invitations.list")).toHaveLength(0);
  });

  it("does not show cached invitations after the viewer changes", async () => {
    viewerUserId.current = "user-me";
    negotiateMethods({});
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    const calls = stubInvitationHttp(() =>
      viewerUserId.current === "user-me" ? [INVITATION] : [],
    );
    const onReview = vi.fn();
    const wrapper = wrapperWithInvitationAuth(
      harness.Wrapper,
      invitationAuth(),
    );
    const view = renderRows(onReview)(wrapper);
    expect(
      await screen.findByTestId("environment-invitation-env-beta"),
    ).toBeTruthy();

    viewerUserId.current = "user-other";
    view.rerender(rowsElement(onReview));

    await waitFor(() => {
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
      expect(
        screen.queryByTestId("environment-invitation-env-beta"),
      ).toBeNull();
    });
  });
});

describe("InviteAcceptDialog", () => {
  function renderDialog(
    outcome: "accepted" | "not_found",
    onAccepted: (environmentId: string) => void,
  ) {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.invitations.accept": () => ({ outcome }),
    });
    render(
      <InviteAcceptDialog
        invitation={INVITATION}
        onClose={() => undefined}
        onAccepted={onAccepted}
      />,
      { wrapper: harness.Wrapper },
    );
    return harness;
  }

  it("shows the grant and accepts only when Accept is pressed, then reports the team to pick", async () => {
    const onAccepted = vi.fn();
    const harness = renderDialog("accepted", onAccepted);

    expect(
      screen.getByRole("heading", { name: "You're invited to Beta" }),
    ).toBeTruthy();
    expect(screen.getByTestId("invite-accept-grant")).toBeTruthy();
    expect(harness.paramsOf("environment.invitations.accept")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("invite-accept"));

    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalledExactlyOnceWith("env-beta");
    });
    expect(harness.paramsOf("environment.invitations.accept")).toEqual([
      { environmentId: "env-beta" },
    ]);
  });

  it("says the invitation is no longer open, and picks nothing, when it was withdrawn", async () => {
    const onAccepted = vi.fn();
    renderDialog("not_found", onAccepted);

    await userEvent.click(screen.getByTestId("invite-accept"));

    expect((await screen.findByTestId("invite-accept-gone")).textContent).toBe(
      "This invitation is no longer open.",
    );
    expect(onAccepted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("invite-accept")).toBeNull();
  });
});
