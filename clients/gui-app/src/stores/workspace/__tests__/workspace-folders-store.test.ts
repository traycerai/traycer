import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_WORKSPACE_FOLDERS_BUCKET,
  migrateWorkspaceFoldersPersistedState,
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "../workspace-folders-store";

const STORAGE_KEY = "traycer-gui-app:workspace-folders";
const HOST_A = "host-a";
const HOST_B = "host-b";

function folderInfo(path: string, hostId: string | null): WorkspaceFolderInfo {
  return {
    path,
    name: path.split("/").pop() ?? path,
    repoIdentifier: null,
    hostId,
  };
}

function bucket(hostId: string | null) {
  return selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    hostId,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceFoldersStore.setState({ byHost: {} });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useWorkspaceFoldersStore", () => {
  it("stamps the first added folder as primary when none is set yet", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/a", HOST_A),
        folderInfo("/b", HOST_A),
      ]);
    expect(bucket(HOST_A).primaryPath).toBe("/a");
  });

  it("setPrimaryFolder switches primary; a non-member path is a no-op", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/a", HOST_A),
        folderInfo("/b", HOST_A),
      ]);

    useWorkspaceFoldersStore.getState().setPrimaryFolder(HOST_A, "/b");
    expect(bucket(HOST_A).primaryPath).toBe("/b");

    useWorkspaceFoldersStore
      .getState()
      .setPrimaryFolder(HOST_A, "/not-a-folder");
    expect(bucket(HOST_A).primaryPath).toBe("/b");
  });

  it("removing the primary folder falls back to the first remaining folder", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/a", HOST_A),
        folderInfo("/b", HOST_A),
        folderInfo("/c", HOST_A),
      ]);
    useWorkspaceFoldersStore.getState().setPrimaryFolder(HOST_A, "/b");

    useWorkspaceFoldersStore.getState().removeFolder(HOST_A, "/b");

    expect(bucket(HOST_A).primaryPath).toBe("/a");
  });

  it("removing a secondary folder leaves primary unchanged", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/a", HOST_A),
        folderInfo("/b", HOST_A),
        folderInfo("/c", HOST_A),
      ]);
    useWorkspaceFoldersStore.getState().setPrimaryFolder(HOST_A, "/b");

    useWorkspaceFoldersStore.getState().removeFolder(HOST_A, "/c");

    expect(bucket(HOST_A).primaryPath).toBe("/b");
  });

  it("removing the last folder empties primary (null, not a dangling path)", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [folderInfo("/a", HOST_A)]);
    useWorkspaceFoldersStore.getState().removeFolder(HOST_A, "/a");
    expect(bucket(HOST_A).primaryPath).toBeNull();
    expect(bucket(HOST_A).folders).toEqual([]);
  });

  it("50->51 cap transition never silently moves primary - evicts the oldest secondary instead", () => {
    const folders = Array.from({ length: 50 }, (_, i) =>
      folderInfo(`/f${i}`, HOST_A),
    );
    useWorkspaceFoldersStore.getState().addResolvedFolders(HOST_A, folders);
    // The oldest folder ("/f0") resolves to primary implicitly - confirm,
    // then add one more to push past the 50-folder cap.
    expect(bucket(HOST_A).primaryPath).toBe("/f0");

    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [folderInfo("/f50", HOST_A)]);

    const state = bucket(HOST_A);
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
            "/legacy-a": folderInfo("/legacy-a", HOST_A),
            "/legacy-b": folderInfo("/legacy-b", HOST_A),
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
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
            "/a": folderInfo("/a", HOST_A),
            "/b": folderInfo("/b", HOST_A),
          },
          primaryPath: "/removed-folder",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    expect(bucket(HOST_A).primaryPath).toBe("/a");
  });

  it("rehydrates a valid persisted primaryPath verbatim", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/a", "/b"],
          folderInfoByPath: {
            "/a": folderInfo("/a", HOST_A),
            "/b": folderInfo("/b", HOST_A),
          },
          primaryPath: "/b",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    expect(bucket(HOST_A).primaryPath).toBe("/b");
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
            "/real": folderInfo("/real", HOST_A),
          },
          primaryPath: "/ghost",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
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
            paths.map((path) => [path, folderInfo(path, HOST_A)]),
          ),
          primaryPath: "/over/0",
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
    expect(state.folders).toHaveLength(50);
    // The cap preserves the stored primary even though it's the oldest.
    expect(state.folders).toContain("/over/0");
    expect(state.primaryPath).toBe("/over/0");
  });

  it("leaves the store empty on first-ever load with no persisted payload", async () => {
    await useWorkspaceFoldersStore.persist.rehydrate();
    expect(useWorkspaceFoldersStore.getState().byHost).toEqual({});
    expect(bucket(HOST_A)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });
});

describe("migrateWorkspaceFoldersPersistedState (v1 -> v2)", () => {
  it("partitions v1 rows into per-host buckets by their hostId stamp, dropping null-stamped rows", () => {
    const migrated = migrateWorkspaceFoldersPersistedState({
      folders: ["/a", "/b", "/c", "/orphan"],
      folderInfoByPath: {
        "/a": folderInfo("/a", HOST_A),
        "/b": folderInfo("/b", HOST_B),
        "/c": folderInfo("/c", HOST_A),
        "/orphan": folderInfo("/orphan", null),
      },
      primaryPath: "/c",
    });

    expect(Object.keys(migrated.byHost).sort()).toEqual([HOST_A, HOST_B]);
    expect(migrated.byHost[HOST_A].folders).toEqual(["/a", "/c"]);
    // The v1 primary belongs to whichever bucket contains its path.
    expect(migrated.byHost[HOST_A].primaryPath).toBe("/c");
    expect(migrated.byHost[HOST_B].folders).toEqual(["/b"]);
    // Every other bucket resolves its own first folder.
    expect(migrated.byHost[HOST_B].primaryPath).toBe("/b");
    // The null-stamped row is attributed to no bucket - it cannot be.
    const everyMigratedFolder = Object.values(migrated.byHost).flatMap(
      (b) => b.folders,
    );
    expect(everyMigratedFolder).not.toContain("/orphan");
  });

  it("drops a row entirely when persisted with no rows at all", () => {
    const migrated = migrateWorkspaceFoldersPersistedState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    expect(migrated.byHost).toEqual({});
  });

  it("applies the 50-folder cap independently per bucket", () => {
    const hostAPaths = Array.from({ length: 55 }, (_, i) => `/a/${i}`);
    const hostBPaths = Array.from({ length: 3 }, (_, i) => `/b/${i}`);
    const folderInfoByPath = {
      ...Object.fromEntries(
        hostAPaths.map((path) => [path, folderInfo(path, HOST_A)]),
      ),
      ...Object.fromEntries(
        hostBPaths.map((path) => [path, folderInfo(path, HOST_B)]),
      ),
    };
    const migrated = migrateWorkspaceFoldersPersistedState({
      folders: [...hostAPaths, ...hostBPaths],
      folderInfoByPath,
      primaryPath: null,
    });

    expect(migrated.byHost[HOST_A].folders).toHaveLength(50);
    expect(migrated.byHost[HOST_B].folders).toHaveLength(3);
  });
});

describe("per-host isolation", () => {
  it("selectWorkspaceFoldersBucket returns the shared empty bucket for a missing/null host", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [folderInfo("/a", HOST_A)]);

    expect(bucket(HOST_B)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
    expect(bucket(null)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });

  it("removeFolder/setPrimaryFolder only affect their own host's bucket", () => {
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/a", HOST_A),
        folderInfo("/b", HOST_A),
      ]);
    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_B, [
        folderInfo("/x", HOST_B),
        folderInfo("/y", HOST_B),
      ]);

    useWorkspaceFoldersStore.getState().setPrimaryFolder(HOST_A, "/b");
    useWorkspaceFoldersStore.getState().removeFolder(HOST_B, "/x");

    expect(bucket(HOST_A).primaryPath).toBe("/b");
    expect(bucket(HOST_A).folders).toEqual(["/a", "/b"]);
    expect(bucket(HOST_B).folders).toEqual(["/y"]);
    // Removing the only staged primary from host B falls back within ITS
    // own bucket, never touching host A's.
    expect(bucket(HOST_B).primaryPath).toBe("/y");
  });

  it("a null hostId no-ops every write and never creates a bucket", () => {
    const evicted = useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(null, [folderInfo("/a", HOST_A)]);
    expect(evicted).toEqual([]);
    expect(useWorkspaceFoldersStore.getState().byHost).toEqual({});

    useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [folderInfo("/a", HOST_A)]);
    useWorkspaceFoldersStore.getState().removeFolder(null, "/a");
    useWorkspaceFoldersStore.getState().setPrimaryFolder(null, "/a");

    expect(bucket(HOST_A).folders).toEqual(["/a"]);
    expect(bucket(HOST_A).primaryPath).toBe("/a");
    expect(bucket(HOST_B)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });

  it("drops a cross-stamped row instead of filing it under the target host", () => {
    // The picker stamps each row with its DISPATCH-time host; a host switch
    // landing between the pick and this call is the race that produces a
    // mismatch. Host B's path must not become a row in host A's bucket.
    const evicted = useWorkspaceFoldersStore
      .getState()
      .addResolvedFolders(HOST_A, [
        folderInfo("/on-a", HOST_A),
        folderInfo("/on-b", HOST_B),
        folderInfo("/unstamped", null),
      ]);

    expect(evicted).toEqual([]);
    expect(bucket(HOST_A).folders).toEqual(["/on-a"]);
    expect(bucket(HOST_A).primaryPath).toBe("/on-a");
    expect(bucket(HOST_B)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });
});

describe("persist merge (v2 payload validation)", () => {
  it("drops a ghost path within a bucket's folders that lacks metadata, re-resolving that bucket's primary", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: {
          byHost: {
            [HOST_A]: {
              folders: ["/ghost", "/real"],
              folderInfoByPath: {
                "/real": folderInfo("/real", HOST_A),
              },
              primaryPath: "/ghost",
            },
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
    expect(state.folders).toEqual(["/real"]);
    expect(state.primaryPath).toBe("/real");
    expect(Object.keys(state.folderInfoByPath)).toEqual(["/real"]);
  });

  it("re-applies the 50-folder cap per bucket on v2 rehydration", async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/over/${i}`);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: {
          byHost: {
            [HOST_A]: {
              folders: paths,
              folderInfoByPath: Object.fromEntries(
                paths.map((path) => [path, folderInfo(path, HOST_A)]),
              ),
              primaryPath: "/over/0",
            },
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
    expect(state.folders).toHaveLength(50);
    expect(state.primaryPath).toBe("/over/0");
  });

  it("keeps buckets for other hosts independent when validating a multi-host v2 payload", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: {
          byHost: {
            [HOST_A]: {
              folders: ["/a"],
              folderInfoByPath: { "/a": folderInfo("/a", HOST_A) },
              primaryPath: "/a",
            },
            [HOST_B]: {
              folders: ["/ghost-b"],
              folderInfoByPath: {},
              primaryPath: "/ghost-b",
            },
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    expect(bucket(HOST_A).folders).toEqual(["/a"]);
    // Host B's only folder is a ghost (no metadata) - its bucket is dropped
    // entirely rather than persisted empty.
    expect(bucket(HOST_B)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });

  it("drops rows whose stamp disagrees with the bucket they are filed under", async () => {
    // A malformed/hand-edited v2 payload: host A's bucket carries a row
    // stamped for host B and one with no stamp at all. Rehydration must not
    // surface either through host A - a bucket only ever holds its own host's
    // paths, however the payload got that way.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: {
          byHost: {
            [HOST_A]: {
              folders: ["/on-b", "/unstamped", "/on-a"],
              folderInfoByPath: {
                "/on-b": folderInfo("/on-b", HOST_B),
                "/unstamped": folderInfo("/unstamped", null),
                "/on-a": folderInfo("/on-a", HOST_A),
              },
              primaryPath: "/on-b",
            },
          },
        },
      }),
    );

    await useWorkspaceFoldersStore.persist.rehydrate();

    const state = bucket(HOST_A);
    expect(state.folders).toEqual(["/on-a"]);
    expect(state.folderInfoByPath).toEqual({
      "/on-a": folderInfo("/on-a", HOST_A),
    });
    // The dropped row was also the stored primary, so primary re-resolves to
    // the surviving folder rather than pointing at a path host A cannot serve.
    expect(state.primaryPath).toBe("/on-a");
    expect(bucket(HOST_B)).toBe(EMPTY_WORKSPACE_FOLDERS_BUCKET);
  });
});
