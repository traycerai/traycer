import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  TeamChatAutoArchiveReadResult,
  TeamChatAutoArchiveSetRequest,
  TeamChatAutoArchiveWriteResult,
} from "@traycer-clients/shared/host-client/team-chat-auto-archive";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  read: vi.fn<(teamId: string) => Promise<TeamChatAutoArchiveReadResult>>(),
  write:
    vi.fn<
      (
        teamId: string,
        request: TeamChatAutoArchiveSetRequest,
      ) => Promise<TeamChatAutoArchiveWriteResult>
    >(),
  list: { current: { environments: [] as unknown[] } },
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    auth: {
      getTeamChatAutoArchive: mocks.read,
      setTeamChatAutoArchive: mocks.write,
    },
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: mocks.list.current }),
}));

import { TeamChatAutoArchiveRow } from "@/components/settings/environment/team-chat-auto-archive-row";

const ACME: EnvironmentDescriptorV11 = {
  environmentId: "env-a",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: null,
};

const SAVED = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 604_800,
  updatedAt: 1_763_100_000_000,
};

function renderRow(role: "admin" | "editor" | null): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<TeamChatAutoArchiveRow environmentId="env-a" role={role} />, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

function mainSwitch(): HTMLElement {
  return screen.getByRole("switch", {
    name: "Archive idle agents automatically",
  });
}

beforeEach(() => {
  mocks.list.current = { environments: [ACME] };
  mocks.read.mockReset();
  mocks.write.mockReset();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("TeamChatAutoArchiveRow", () => {
  it("shows a team that never saved one off, and an Editor's switch saves it on", async () => {
    mocks.read.mockResolvedValue({ kind: "ok", record: null });
    mocks.write.mockResolvedValue({
      kind: "ok",
      record: { ...SAVED, idleSeconds: 3600, updatedAt: 1 },
    });
    renderRow("editor");

    await waitFor(() =>
      expect(mainSwitch().hasAttribute("disabled")).toBe(false),
    );
    expect(mainSwitch().getAttribute("aria-checked")).toBe("false");
    expect(mocks.read).toHaveBeenCalledWith("team-a");
    expect(
      screen.getByText(
        "Tidy up chats agents started once they go quiet. Applies on every host in this environment.",
      ),
    ).toBeTruthy();

    await userEvent.click(mainSwitch());

    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("team-a", {
      enabled: true,
      includeUserCreated: false,
      idleSeconds: 3600,
    });
    expect(
      await screen.findByText("Include chats members started"),
    ).toBeTruthy();
    expect(
      screen.getByText("Terminal agent chats count as started by a member"),
    ).toBeTruthy();
  });

  it("shows a reader who may not change it the saved value with every control greyed out", async () => {
    mocks.read.mockResolvedValue({ kind: "ok", record: SAVED });
    renderRow(null);

    expect(
      await screen.findByText("Include chats members started"),
    ).toBeTruthy();
    expect(mainSwitch().getAttribute("aria-checked")).toBe("true");
    for (const control of screen.getAllByRole("switch")) {
      expect(control.hasAttribute("disabled")).toBe(true);
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("says the read failed in the account row's words when the read is refused", async () => {
    mocks.read.mockResolvedValue({ kind: "forbidden" });
    renderRow("admin");

    expect(
      await screen.findByText(
        "Couldn't read the auto-archive setting from this host.",
      ),
    ).toBeTruthy();
    expect(mainSwitch().hasAttribute("disabled")).toBe(true);
  });
});
