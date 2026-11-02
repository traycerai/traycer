import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import { TeamSkillsPage } from "@/components/settings/environment/team-skills";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
// The ambient host binding is what the viewing-host binding re-provides.
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => ({
    hostId: "host-local",
    hostClient: requireTeamHostClient(),
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const host: EnvironmentHostRecordV12 = {
  hostId: "host-a",
  hostLabel: "Mac mini",
  hostPlatform: "darwin",
  enrolledByUserId: "u-1",
  kind: "personal",
  boundAt: 1,
  reachable: true,
  lastReportedAt: 1,
  hasLocalRow: false,
  applied: [],
};

const environments = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

function handlers(
  hosts: EnvironmentHostRecordV12[],
  upload: () => {
    outcome: "saved" | "forbidden" | "refused" | "not_served";
    reason: string | null;
  },
) {
  return {
    "environment.host.list": () => ({ hosts }),
    "environment.list": () => environments,
    "environment.configuration.skills.upload": upload,
  } as const;
}

const SAVED = { outcome: "saved" as const, reason: null };

function skillArchive(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "review.tar.gz", {
    type: "application/gzip",
  });
}

describe("Team skills upload", () => {
  it("uploads the named archive to this team's environment from the eligible host", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers([host], () => SAVED),
    );
    render(<TeamSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.type(
      await screen.findByLabelText("Skill name"),
      " review ",
    );
    await userEvent.upload(
      screen.getByLabelText("Skill folder archive"),
      skillArchive(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a skill" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.skills.upload"),
      ).toEqual([
        { environmentId: "env-a", name: "review", archive: "AQIDBA==" },
      ]);
    });
    // A saved upload clears the draft.
    await waitFor(() => {
      expect(screen.getByLabelText("Skill name")).toHaveProperty("value", "");
    });
  });

  it.each([
    {
      what: "the only host there is, is the one that refused",
      hosts: [host],
      line: "Skills need a host running Acme.",
      switchable: false,
    },
    {
      what: "another host could take it",
      hosts: [host, { ...host, hostId: "host-b", hostLabel: "Studio" }],
      line: "Skills need a host running Acme.Pick one.",
      switchable: true,
    },
  ])(
    "swaps the upload form for the no-host line when the host does not serve the team, and offers a switch only where there is one: $what",
    async ({ hosts, line, switchable }) => {
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers(hosts, () => ({ outcome: "not_served", reason: null })),
      );
      render(<TeamSkillsPage />, { wrapper: harness.Wrapper });

      await userEvent.type(
        await screen.findByLabelText("Skill name"),
        "review",
      );
      await userEvent.upload(
        screen.getByLabelText("Skill folder archive"),
        skillArchive(),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Add a skill" }),
      );

      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe(line);
      });
      expect(screen.queryByRole("button", { name: "Add a skill" })).toBeNull();
      // A refusal is the moment this page needs a host of its own, so the
      // picker is mounted here - and it draws a switch only when there is a
      // host to switch to.
      expect(screen.queryAllByRole("combobox").length > 0).toBe(switchable);
    },
  );

  it("refuses an archive over 32 MB without sending it", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers([host], () => SAVED),
    );
    render(<TeamSkillsPage />, { wrapper: harness.Wrapper });

    const big = skillArchive();
    Object.defineProperty(big, "size", { value: 33 * 1024 * 1024 });
    await userEvent.type(await screen.findByLabelText("Skill name"), "review");
    await userEvent.upload(screen.getByLabelText("Skill folder archive"), big);
    await userEvent.click(screen.getByRole("button", { name: "Add a skill" }));

    expect(
      await screen.findByText("Choose a skill smaller than 32 MB."),
    ).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.skills.upload"),
    ).toHaveLength(0);
  });

  it("gives a viewer the skills with no upload verb", async () => {
    const harness = mountTeamPage(
      poolSource("viewer"),
      handlers([host], () => SAVED),
    );
    render(<TeamSkillsPage />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(harness.paramsOf("environment.host.list")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(harness.paramsOf("providers.list").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: "Add a skill" })).toBeNull();
    expect(screen.queryByLabelText("Skill folder archive")).toBeNull();
  });

  it("says skills need a host, exactly, with no upload verb when the team has no eligible host", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers([], () => SAVED),
    );
    render(<TeamSkillsPage />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Skills need a host running Acme.Start an Acme sandbox to see them.",
      );
    });
    expect(screen.queryByRole("button", { name: "Add a skill" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pick one." })).toBeNull();
    expect(
      harness.paramsOf("environment.configuration.skills.upload"),
    ).toHaveLength(0);
  });
});
