/**
 * `IdentitySkillInstallButton`: hidden when the host doesn't advertise the
 * skill installer, otherwise an icon button that opens the shared skill
 * composer preselected on this identity, and routes an import back to
 * `onInstalled` only when the paths belong to THIS identity.
 *
 * `useIdentitySkillTargets` is mocked so the test drives its return value
 * directly rather than a real host round trip; the composer dialog itself is
 * real, matching `provider-skill-composer-dialog.test.tsx`'s own rendering.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentitySkillTarget } from "@/lib/identities/skill-install-target";
import { IdentitySkillInstallButton } from "@/components/identities/identity-skill-install";

interface MockIdentityState {
  readonly identity: { readonly title: string } | null;
}

type UseIdentitySkillTargetsArgs = {
  readonly client: unknown;
  readonly hostId: string | null;
  readonly enabled: boolean;
  readonly pinned: {
    readonly identityId: string;
    readonly title: string;
  } | null;
  readonly onImported: (identityId: string, paths: readonly string[]) => void;
};

type UseIdentitySkillTargetsResult = {
  readonly supported: boolean;
  readonly targets: readonly IdentitySkillTarget[];
  readonly pending: boolean;
};

const useIdentitySkillTargetsMock = vi.hoisted(() =>
  vi.fn<(args: UseIdentitySkillTargetsArgs) => UseIdentitySkillTargetsResult>(),
);

vi.mock("@/hooks/identities/use-identity-skill-targets", () => ({
  useIdentitySkillTargets: (args: UseIdentitySkillTargetsArgs) =>
    useIdentitySkillTargetsMock(args),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

const identityState: MockIdentityState = { identity: { title: "Research" } };

vi.mock("@/lib/identity-selectors", () => ({
  useOpenIdentityState: <T,>(selector: (state: MockIdentityState) => T): T =>
    selector(identityState),
}));

afterEach(() => {
  cleanup();
  useIdentitySkillTargetsMock.mockReset();
});

function lastHookArgs(): UseIdentitySkillTargetsArgs {
  const call = useIdentitySkillTargetsMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("useIdentitySkillTargets was never called");
  }
  return call[0];
}

describe("<IdentitySkillInstallButton />", () => {
  it("renders nothing when the host does not advertise the skill installer", () => {
    useIdentitySkillTargetsMock.mockReturnValue({
      supported: false,
      targets: [],
      pending: false,
    });

    render(
      <IdentitySkillInstallButton
        identityId="identity-1"
        disabled={false}
        onInstalled={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("identity-install-skill")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install skill" })).toBeNull();
  });

  it("renders a button that opens the composer preselected on this identity when supported", () => {
    const identityMutate = vi.fn<
      (mutation: unknown) => Promise<{
        readonly kind: "skills";
        readonly skills: readonly [];
      }>
    >();
    identityMutate.mockResolvedValue({ kind: "skills", skills: [] });
    useIdentitySkillTargetsMock.mockReturnValue({
      supported: true,
      targets: [
        {
          identityId: "identity-1",
          title: "Research",
          onMutate: identityMutate,
        },
      ],
      pending: false,
    });

    render(
      <IdentitySkillInstallButton
        identityId="identity-1"
        disabled={false}
        onInstalled={vi.fn()}
      />,
    );

    const button = screen.getByTestId("identity-install-skill");
    expect(button).toBeDefined();
    expect(screen.getByRole("button", { name: "Install skill" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Add a skill")).toBeDefined();
    expect(screen.getByLabelText("Skill source")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "or write one from scratch" }),
    ).toBeNull();
  });

  it("calls the last useIdentitySkillTargets pinned request with this identity's id and title", () => {
    useIdentitySkillTargetsMock.mockReturnValue({
      supported: false,
      targets: [],
      pending: false,
    });

    render(
      <IdentitySkillInstallButton
        identityId="identity-1"
        disabled={false}
        onInstalled={vi.fn()}
      />,
    );

    expect(lastHookArgs().pinned).toEqual({
      identityId: "identity-1",
      title: "Research",
    });
  });

  it("calls onInstalled with the imported SKILL.md path for this identity, and not for another identity", () => {
    useIdentitySkillTargetsMock.mockReturnValue({
      supported: false,
      targets: [],
      pending: false,
    });
    const onInstalled = vi.fn<(path: string) => void>();

    render(
      <IdentitySkillInstallButton
        identityId="identity-1"
        disabled={false}
        onInstalled={onInstalled}
      />,
    );

    const { onImported } = lastHookArgs();

    onImported("identity-1", ["skills/x/SKILL.md", "skills/x/a.py"]);
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith("skills/x/SKILL.md");

    onInstalled.mockClear();
    onImported("identity-2", ["skills/x/SKILL.md", "skills/x/a.py"]);
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
