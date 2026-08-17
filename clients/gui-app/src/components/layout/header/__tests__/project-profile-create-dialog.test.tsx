import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { ProjectProfileCreateDialog } from "@/components/layout/header/project-profile-create-dialog";
import type { PrepareFoldersWithHostResult } from "@/hooks/workspace/use-workspace-folder-actions";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";
const PICKED_PATH = "/picked/crm";

const testState = vi.hoisted(() => ({
  pickResult: null as PrepareFoldersWithHostResult | null,
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", async (importActual) => ({
  ...(await importActual()),
  useWorkspaceFolderActions: () => ({
    isPreparing: false,
    pickAndPrepareFolders: () => Promise.resolve(testState.pickResult),
  }),
}));

function catalogFolders(): ReadonlyArray<string> {
  return selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    HOST,
  ).folders;
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <ProjectProfileCreateDialog
        hostId={HOST}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function pickFolder() {
  fireEvent.click(screen.getByTestId("project-profile-choose-folder"));
}

function typeName(name: string) {
  fireEvent.change(screen.getByTestId("project-profile-name"), {
    target: { value: name },
  });
}

describe("<ProjectProfileCreateDialog />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    testState.pickResult = {
      folders: [
        {
          workspacePath: PICKED_PATH,
          workspaceName: "crm",
          repoIdentifier: null,
          repoUrl: null,
        },
      ],
      repoIdentifiers: [],
      hostId: HOST,
    };
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useProjectProfilesStore.setState({ byHost: {} });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useProjectProfilesStore.setState({ byHost: {} });
  });

  it("keeps the picked folder out of the catalog while the dialog is open", async () => {
    render(<Harness />);

    pickFolder();

    expect(
      await screen.findByTestId(`project-profile-folder-${PICKED_PATH}`),
    ).not.toBeNull();
    expect(catalogFolders()).toEqual([]);
  });

  it("discards the pick on Cancel and leaves the catalog untouched", async () => {
    render(<Harness />);

    pickFolder();
    await screen.findByTestId(`project-profile-folder-${PICKED_PATH}`);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByTestId("project-profile-create-dialog")).toBeNull();
    });
    expect(catalogFolders()).toEqual([]);

    fireEvent.click(screen.getByTestId("reopen"));
    expect(
      await screen.findByTestId("project-profile-create-dialog"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId(`project-profile-folder-${PICKED_PATH}`),
    ).toBeNull();
    expect(catalogFolders()).toEqual([]);
  });

  it("adds the picked folder to the catalog on Create and seeds the profile from it", async () => {
    render(<Harness />);

    typeName("CRM");
    pickFolder();
    await screen.findByTestId(`project-profile-folder-${PICKED_PATH}`);
    fireEvent.click(screen.getByTestId("project-profile-create-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("project-profile-create-dialog")).toBeNull();
    });
    expect(catalogFolders()).toEqual([PICKED_PATH]);
    const active = selectActiveProjectProfile(
      useProjectProfilesStore.getState(),
      HOST,
    );
    expect(active?.name).toBe("CRM");
    expect(active?.folderPaths).toEqual([PICKED_PATH]);
    expect(active?.primaryPath).toBe(PICKED_PATH);
  });
});
