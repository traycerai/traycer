import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillEnvironmentRoute } from "../use-skill-environment-route";

const route = vi.hoisted(() => ({
  statusVersion: false as false | null | { major: number; minor: number },
  bindingSupport: true as boolean | null,
  bindingEnabled: [] as boolean[],
  binding: undefined as
    | {
        environment: {
          environmentId: string;
          ownerKind: "user" | "organization";
          label: string;
        };
      }
    | undefined,
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
vi.mock("@/hooks/host/use-requester-host-id", () => ({
  useRequesterHostId: () => "host_this",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => route.bindingSupport,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: (
    _client: null,
    _hostId: string,
    enabled: boolean,
  ) => {
    route.bindingEnabled.push(enabled);
    // A disabled read still answers from a primed cache.
    return { data: route.binding };
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

const PERSONAL_BINDING = {
  environment: {
    environmentId: "env_me",
    ownerKind: "user" as const,
    label: "someone",
  },
};
const TEAM_BINDING = {
  environment: {
    environmentId: "env_acme",
    ownerKind: "organization" as const,
    label: "Acme",
  },
};

beforeEach(() => {
  route.statusVersion = { major: 1, minor: 1 };
  route.bindingSupport = true;
  route.bindingEnabled = [];
  route.binding = PERSONAL_BINDING;
  route.uploads = [];
  route.uploadAnswer = { outcome: "saved", reason: null };
});

describe("useSkillEnvironmentRoute", () => {
  it("reads a host that never answers environment.status as one that still writes the shared folder, and does not ask it what it serves", () => {
    route.statusVersion = false;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.hostRunsEnvironments).toBe(false);
    expect(route.bindingEnabled).toEqual([false]);
    expect(result.current.served).toBeNull();
  });

  it("reads a host whose manifest has not arrived as neither, and has nowhere to write despite a cached binding", async () => {
    route.statusVersion = null;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.hostRunsEnvironments).toBeNull();
    expect(route.bindingEnabled).toEqual([false]);
    expect(result.current.served).toBeNull();
    await expect(result.current.write(SKILL)).resolves.toMatch(/Couldn't add/);
    expect(route.uploads).toEqual([]);
  });

  it("does not ask a host without the binding read what it serves", () => {
    route.bindingSupport = false;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(route.bindingEnabled).toEqual([false]);
    expect(result.current.served).toBeNull();
  });

  it("names a personal machine's environment Personal and writes to it", async () => {
    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.served).toEqual({
      environmentId: "env_me",
      name: "Personal",
      team: false,
    });
    await expect(result.current.write(SKILL)).resolves.toBeNull();
    expect(route.uploads).toEqual([
      { environmentId: "env_me", name: "review-pr" },
    ]);
  });

  it("writes to the team a team-bound host serves, by the team's name", async () => {
    route.binding = TEAM_BINDING;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.served).toEqual({
      environmentId: "env_acme",
      name: "Acme",
      team: true,
    });
    await expect(result.current.write(SKILL)).resolves.toBeNull();
    expect(route.uploads).toEqual([
      { environmentId: "env_acme", name: "review-pr" },
    ]);
  });

  it("has nowhere to write until the host's environment is known", async () => {
    route.binding = undefined;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    expect(result.current.served).toBeNull();
    await expect(result.current.write(SKILL)).resolves.toMatch(/Couldn't add/);
    expect(route.uploads).toEqual([]);
  });

  it.each([
    [{ outcome: "not_served", reason: null }, /isn't running Acme/],
    [{ outcome: "refused", reason: "read_only" }, /review-pr/],
    [{ outcome: "refused", reason: "too_large" }, /Couldn't add/],
    [{ outcome: "forbidden", reason: null }, /Only Acme's editors/],
  ])("words the refusal %j", async (answer, words) => {
    route.binding = TEAM_BINDING;
    route.uploadAnswer = answer;

    const { result } = renderHook(() => useSkillEnvironmentRoute());

    await expect(result.current.write(SKILL)).resolves.toMatch(words);
  });
});
