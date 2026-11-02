import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillEnvironmentRoute } from "../use-skill-environment-route";

const route = vi.hoisted(() => ({
  statusVersion: false as false | null | { major: number; minor: number },
  listEnabled: [] as boolean[],
  environments: [] as ReadonlyArray<{
    environmentId: string;
    ownerKind: "user" | "organization";
  }>,
  uploads: [] as Array<{ environmentId: string; name: string }>,
  uploadAnswer: { outcome: "saved", reason: null } as {
    outcome: string;
    reason: string | null;
  },
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: (_client: null, method: string) =>
    method === "environment.status" ? route.statusVersion : false,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: (_client: null, enabled: boolean) => {
    route.listEnabled.push(enabled);
    return { data: { environments: route.environments } };
  },
}));
vi.mock("@/hooks/environment/team/use-skills-upload-mutation", () => ({
  useConfigurationSkillsUploadMutation: () => ({
    isPending: false,
    mutateAsync: (request: { environmentId: string; name: string }) => {
      route.uploads.push({
        environmentId: request.environmentId,
        name: request.name,
      });
      return Promise.resolve(route.uploadAnswer);
    },
  }),
}));

const SKILL = { name: "review-pr", markdown: "---\nname: review-pr\n---\n" };

beforeEach(() => {
  route.statusVersion = { major: 1, minor: 1 };
  route.listEnabled = [];
  route.environments = [
    { environmentId: "env_team", ownerKind: "organization" },
    { environmentId: "env_me", ownerKind: "user" },
  ];
  route.uploads = [];
  route.uploadAnswer = { outcome: "saved", reason: null };
});

describe("useSkillEnvironmentRoute", () => {
  it("reads a host that never answers environment.status as one that still writes the shared folder, and does not ask it for environments", () => {
    route.statusVersion = false;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.hostRunsEnvironments).toBe(false);
    expect(route.listEnabled).toEqual([false]);
  });

  it("writes to the person's own environment, never a team's", async () => {
    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.hostRunsEnvironments).toBe(true);
    expect(result.current.available).toBe(true);
    await expect(result.current.write(SKILL)).resolves.toBeNull();
    expect(route.uploads).toEqual([
      { environmentId: "env_me", name: "review-pr" },
    ]);
  });

  it("has nowhere to write until the person's environment is known", async () => {
    route.environments = [
      { environmentId: "env_team", ownerKind: "organization" },
    ];

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.available).toBe(false);
    await expect(result.current.write(SKILL)).resolves.toMatch(/Couldn't add/);
    expect(route.uploads).toEqual([]);
  });

  it.each([
    [{ outcome: "not_served", reason: null }, /isn't running the environment/],
    [{ outcome: "refused", reason: "read_only" }, /review-pr/],
    [{ outcome: "forbidden", reason: null }, /Couldn't add/],
  ])("words the refusal %j", async (answer, words) => {
    route.uploadAnswer = answer;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    await expect(result.current.write(SKILL)).resolves.toMatch(words);
  });
});
