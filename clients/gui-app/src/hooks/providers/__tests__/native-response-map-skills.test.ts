import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
import { describe, expect, it } from "vitest";
import {
  mapNativeMutateToSkillsMutate,
  ProviderNativeRpcError,
} from "@/hooks/providers/native-response-map";

const REVIEW_PR: ProviderSkill = {
  name: "review-pr",
  description: "Reviews a pull request.",
  path: "/Users/dev/.agents/skills/review-pr",
  source: "shared",
};

describe("mapNativeMutateToSkillsMutate", () => {
  it("maps a skills list mutation to kind: skills", () => {
    expect(
      mapNativeMutateToSkillsMutate({
        response: {
          result: { ok: true, kind: "skills", skills: [REVIEW_PR] },
        },
      }),
    ).toEqual({ kind: "skills", skills: [REVIEW_PR] });
  });

  it("maps skillsInspect to kind: inspect instead of throwing unsupported_action", () => {
    const mapped = mapNativeMutateToSkillsMutate({
      response: {
        result: {
          ok: true,
          kind: "skillsInspect",
          token: "tok-1",
          commitSha: "deadbeef",
          candidates: [
            {
              name: "show-me",
              description: "Visual diagrams",
              relPath: "show-me/SKILL.md",
              installed: false,
            },
          ],
        },
      },
    });
    expect(mapped).toEqual({
      kind: "inspect",
      token: "tok-1",
      candidates: [
        {
          name: "show-me",
          description: "Visual diagrams",
          relPath: "show-me/SKILL.md",
          installed: false,
        },
      ],
    });
  });

  it("still throws unsupported_action for a non-skills mutate kind", () => {
    expect(() =>
      mapNativeMutateToSkillsMutate({
        response: {
          result: { ok: true, kind: "plugins", plugins: [] },
        },
      }),
    ).toThrow(ProviderNativeRpcError);
    try {
      mapNativeMutateToSkillsMutate({
        response: {
          result: { ok: true, kind: "plugins", plugins: [] },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderNativeRpcError);
      if (error instanceof ProviderNativeRpcError) {
        expect(error.nativeCode).toBe("unsupported_action");
      }
    }
  });
});
