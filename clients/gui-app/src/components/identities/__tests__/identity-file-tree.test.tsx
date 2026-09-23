/**
 * `IdentityFileTree`: group rendering (Soul/Memories/Skills), the pending
 * badge on a pending blob, and row selection.
 *
 * The mutation hooks and `useTabHostClient` are faked - this suite is about
 * the tree's rendering and dispatch, not the host transport - and
 * `useIdentityFileIsDirty` is faked to `false` so each row does not need a
 * real `OpenIdentityContext`.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { IdentityFileTree } from "@/components/identities/identity-file-tree";
import type { IdentityTreeGroup } from "@/lib/identities/file-tree";
import { IDENTITY_FILE_GROUPS } from "@/lib/identities/file-tree";

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/identities/use-identity-mutations", () => ({
  useIdentityFileAddForClient: () => ({ mutate: vi.fn(), isPending: false }),
  useIdentityFileRenameForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useIdentityFileDeleteForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useIdentityUploadBlobChunkForClient: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/identity-selectors", () => ({
  useIdentityFileIsDirty: () => false,
}));

function groupsFixture(): readonly IdentityTreeGroup[] {
  return IDENTITY_FILE_GROUPS.map((group) => {
    if (group.id === "soul") {
      return {
        ...group,
        files: [
          {
            path: "SOUL.md",
            name: "SOUL.md",
            group: "soul" as const,
            kind: "document" as const,
            mediaType: "text/markdown",
            byteLength: null,
            status: null,
            pending: false,
            executable: false,
          },
        ],
      };
    }
    if (group.id === "memories") {
      return {
        ...group,
        files: [
          {
            path: "memories/a.md",
            name: "a.md",
            group: "memories" as const,
            kind: "document" as const,
            mediaType: "text/markdown",
            byteLength: null,
            status: null,
            pending: false,
            executable: false,
          },
        ],
      };
    }
    if (group.id === "skills") {
      return {
        ...group,
        files: [
          {
            path: "skills/reviewer/SKILL.md",
            name: "SKILL.md",
            group: "skills" as const,
            kind: "document" as const,
            mediaType: "text/markdown",
            byteLength: null,
            status: null,
            pending: false,
            executable: false,
          },
          {
            path: "skills/reviewer/logo.png",
            name: "logo.png",
            group: "skills" as const,
            kind: "blob" as const,
            mediaType: "image/png",
            byteLength: 2048,
            status: "pending",
            pending: true,
            executable: false,
          },
        ],
      };
    }
    return { ...group, files: [] };
  });
}

function renderTree(
  overrides: Partial<{
    readonly selectedPath: string | null;
    readonly onSelect: (path: string) => void;
  }>,
) {
  const onSelect = overrides.onSelect ?? vi.fn();
  render(
    <TabHostProvider hostId="host-a">
      <IdentityFileTree
        identityId="identity_1"
        groups={groupsFixture()}
        hydrated
        selectedPath={overrides.selectedPath ?? null}
        onSelect={onSelect}
      />
    </TabHostProvider>,
  );
  return { onSelect };
}

describe("IdentityFileTree", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the Soul, Memories and Skills groups with their files", () => {
    renderTree({});

    const soul = screen.getByTestId("identity-tree-group-soul");
    expect(within(soul).getByText("SOUL.md")).not.toBeNull();

    const memories = screen.getByTestId("identity-tree-group-memories");
    expect(within(memories).getByText("a.md")).not.toBeNull();

    const skills = screen.getByTestId("identity-tree-group-skills");
    expect(within(skills).getByText("SKILL.md")).not.toBeNull();
    expect(within(skills).getByText("logo.png")).not.toBeNull();
  });

  it("shows the pending badge for a pending blob and not for a ready document", () => {
    renderTree({});

    const rowByPath = (path: string): HTMLElement => {
      const row = screen
        .getAllByTestId("identity-file-row")
        .find((candidate) => candidate.getAttribute("data-path") === path);
      if (row === undefined) throw new Error(`row not found for ${path}`);
      return row;
    };

    expect(
      within(rowByPath("skills/reviewer/logo.png")).getByTestId(
        "identity-file-pending",
      ),
    ).not.toBeNull();
    expect(
      within(rowByPath("SOUL.md")).queryByTestId("identity-file-pending"),
    ).toBeNull();
  });

  it("clicking a row calls onSelect with its path", () => {
    const { onSelect } = renderTree({});

    fireEvent.click(screen.getByText("SOUL.md"));

    expect(onSelect).toHaveBeenCalledWith("SOUL.md");
  });
});
