import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const prepareImage = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("@/lib/appearance/appearance-image-preparation", () => ({
  prepareAppearanceImage: prepareImage,
}));
vi.mock("@/hooks/appearance/use-workspace-appearance", () => ({
  useWorkspaceAppearance: () => ({
    appearance: {
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      status: "present",
      appearance: { version: 1, color: "#112233", icon: null },
      issues: [],
    },
    canEdit: true,
    scope: null,
    assetRefreshKey: 1,
  }),
  useWorkspaceSetAppearance: () => ({ isPending: false, mutateAsync }),
}));

describe("useRepoIdentityDraft", () => {
  it("keeps an existing color edit while a logo is preparing and blocks save", async () => {
    const preparation = new Promise<never>(() => {});
    prepareImage.mockReturnValue(preparation);
    const { useRepoIdentityDraft } =
      await import("@/components/workspaces/use-repo-identity-draft");
    const { result } = renderHook(() =>
      useRepoIdentityDraft({
        hostId: "host-a",
        workspacePath: "/repo",
        epicId: "epic-1",
      }),
    );

    act(() => result.current.setColor("#445566"));
    expect(result.current.values.color).toBe("#445566");
    expect(result.current.changed).toBe(true);

    act(() => result.current.chooseLogo(new File(["logo"], "logo.png")));
    await expect(result.current.save()).rejects.toThrow(
      "Repository identity is not ready to save.",
    );
    expect(result.current.values.color).toBe("#445566");
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
