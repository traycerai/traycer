import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "../workspace-folders-store";

const STORAGE_KEY = "traycer-gui-app:workspace-folders";

function folderInfo(path: string): WorkspaceFolderInfo {
  return { path, name: path.split("/").pop() ?? path, repoIdentifier: null };
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useWorkspaceFoldersStore", () => {
  it("stamps the first added folder as primary when none is set yet", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([folderInfo("/a"), folderInfo("/b")]);
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/a");
  });

  it("setPrimaryFolder switches primary; a non-member path is a no-op", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([folderInfo("/a"), folderInfo("/b")]);

    useWorkspaceFoldersStore.getState().setPrimaryFolder("/b");
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/b");

    useWorkspaceFoldersStore.getState().setPrimaryFolder("/not-a-folder");
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/b");
  });

  it("removing the primary folder falls back to the first remaining folder", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([
        folderInfo("/a"),
        folderInfo("/b"),
        folderInfo("/c"),
      ]);
    useWorkspaceFoldersStore.getState().setPrimaryFolder("/b");

    useWorkspaceFoldersStore.getState().removeFolder("/b");

    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/a");
  });

  it("removing a secondary folder leaves primary unchanged", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([
        folderInfo("/a"),
        folderInfo("/b"),
        folderInfo("/c"),
      ]);
    useWorkspaceFoldersStore.getState().setPrimaryFolder("/b");

    useWorkspaceFoldersStore.getState().removeFolder("/c");

    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/b");
  });

  it("removing the last folder empties primary (null, not a dangling path)", () => {
    useWorkspaceFoldersStore.getState().addResolvedFolders([folderInfo("/a")]);
    useWorkspaceFoldersStore.getState().removeFolder("/a");
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBeNull();
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([]);
  });

  it("50->51 cap transition never silently moves primary - evicts the oldest secondary instead", () => {
    const folders = Array.from({ length: 50 }, (_, i) => folderInfo(`/f${i}`));
    useWorkspaceFoldersStore.getState().addResolvedFolders(folders);
    // The oldest folder ("/f0") resolves to primary implicitly - confirm,
    // then add one more to push past the 50-folder cap.
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/f0");

    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders([folderInfo("/f50")]);

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toHaveLength(50);
    expect(state.primaryPath).toBe("/f0");
    expect(state.folders).toContain("/f0");
    expect(state.folders).toContain("/f50");
    // "/f1" was the oldest SECONDARY - it is the one evicted, not "/f0".
    expect(state.folders).not.toContain("/f1");
  });

  it("rehydrates a v1 payload (no primaryPath field) by resolving folders[0] as primary", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/legacy-a", "/legacy-b"],
          folderInfoByPath: {
            "/legacy-a": folderInfo("/legacy-a"),
            "/legacy-b": folderInfo("/legacy-b"),
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toEqual(["/legacy-a", "/legacy-b"]);
    expect(state.primaryPath).toBe("/legacy-a");
  });

  it("rehydrates a stale/out-of-bounds primaryPath by falling back to folders[0]", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/a", "/b"],
          folderInfoByPath: {
            "/a": folderInfo("/a"),
            "/b": folderInfo("/b"),
          },
          primaryPath: "/removed-folder",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/a");
  });

  it("rehydrates a valid persisted primaryPath verbatim", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/a", "/b"],
          folderInfoByPath: {
            "/a": folderInfo("/a"),
            "/b": folderInfo("/b"),
          },
          primaryPath: "/b",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    expect(useWorkspaceFoldersStore.getState().primaryPath).toBe("/b");
  });

  it("drops a ghost folder (present in folders, no/corrupt metadata) on rehydration and never resolves it as primary", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          // "/ghost" has no metadata entry; "/corrupt" has a mismatched one.
          folders: ["/ghost", "/corrupt", "/real"],
          folderInfoByPath: {
            "/corrupt": { path: "/DIFFERENT-path", name: "corrupt" },
            "/real": folderInfo("/real"),
          },
          primaryPath: "/ghost",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = useWorkspaceFoldersStore.getState();
    // Folders are filtered against successfully-parsed metadata BEFORE the
    // primary resolves - a ghost path must neither survive nor win primary.
    expect(state.folders).toEqual(["/real"]);
    expect(state.primaryPath).toBe("/real");
    expect(Object.keys(state.folderInfoByPath)).toEqual(["/real"]);
  });

  it("reapplies the 50-folder cap on rehydration of an oversized persisted payload", async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/over/${i}`);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          folders: paths,
          folderInfoByPath: Object.fromEntries(
            paths.map((path) => [path, folderInfo(path)]),
          ),
          primaryPath: "/over/0",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toHaveLength(50);
    // The cap preserves the stored primary even though it's the oldest.
    expect(state.folders).toContain("/over/0");
    expect(state.primaryPath).toBe("/over/0");
  });

  it("leaves the store empty on first-ever load with no persisted payload", async () => {
    await useWorkspaceFoldersStore.persist.rehydrate();
    const state = useWorkspaceFoldersStore.getState();
    expect(state.folders).toEqual([]);
    expect(state.primaryPath).toBeNull();
  });
});
