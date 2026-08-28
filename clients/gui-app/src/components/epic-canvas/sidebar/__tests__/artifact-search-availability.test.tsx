/**
 * Integrated cover for the artifact-search availability gate.
 *
 * The sibling `epic-sidebar-artifact-search.test.tsx` mocks `use-epic-store`
 * file-wide, so it can prove what the shell DOES with the gate's answer but not
 * that a real artifact deletion produces that answer: it swaps a plain value and
 * forces a rerender. That leaves the notification half - doc write, projector,
 * `artifacts.allIds`, Zustand subscription, re-render - entirely unexercised,
 * and that chain is app code, not library behaviour.
 *
 * So this file mocks nothing. It drives a real `createOpenEpicStore` through the
 * same `EpicSessionContext` the app uses, mutates the Y.Doc the way the host
 * would, and asserts the hook flips WITHOUT any manual rerender.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useArtifactSearchAvailable } from "@/components/epic-canvas/sidebar/artifact-search-availability";

/** Minimal stream client: this suite drives the doc directly, never the wire. */
const inertStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

let opened: OpenEpicStoreHandle | null = null;

afterEach(() => {
  cleanup();
  opened?.dispose();
  opened = null;
});

function openStore(): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId: "epic-availability",
    streamClientFactory: inertStreamFactory,
    userId: null,
    onAuthError: null,
  });
  // A writable role, the way the host's meta/permission frames would set it:
  // the gate also withholds search from viewers (and from a not-yet-known
  // role), so the artifact-count cases below need write access as a given.
  handle.store.setState({ permissionRole: "editor" });
  opened = handle;
  return handle;
}

/** Writes an artifact the way the host's snapshot does. */
function seedArtifact(doc: Y.Doc, artifactId: string): void {
  const epicMap = doc.getMap<unknown>("epic");
  let artifacts = epicMap.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    artifacts = new Y.Map<unknown>();
    epicMap.set("artifacts", artifacts);
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", artifactId);
  entry.set("kind", "spec");
  entry.set("title", "Spec One");
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  (artifacts as Y.Map<unknown>).set(artifactId, entry);
}

function deleteArtifact(doc: Y.Doc, artifactId: string): void {
  const artifacts = doc.getMap<unknown>("epic").get("artifacts");
  if (artifacts instanceof Y.Map) artifacts.delete(artifactId);
}

/** Renders the gate's answer, so a re-render is observable as text. */
function AvailabilityProbe() {
  const available = useArtifactSearchAvailable();
  return <span role="status">{available ? "yes" : "no"}</span>;
}

function availability(): string {
  return screen.getByRole("status").textContent;
}

describe("useArtifactSearchAvailable against a real Epic store", () => {
  it("answers no for an Epic with no artifacts", () => {
    const handle = openStore();
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );
    expect(availability()).toBe("no");
  });

  it("flips to yes when a first artifact lands, with no forced rerender", () => {
    const handle = openStore();
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );
    expect(availability()).toBe("no");

    act(() => {
      seedArtifact(handle.doc, "art-1");
    });

    // No rerender was requested: the doc write alone has to reach the hook
    // through the projector and the store subscription.
    expect(availability()).toBe("yes");
  });

  it("flips back to no when the last artifact is deleted", () => {
    const handle = openStore();
    act(() => {
      seedArtifact(handle.doc, "art-1");
    });
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );
    expect(availability()).toBe("yes");

    // The transition the shell's close-on-empty effect depends on. The sibling
    // suite can only simulate this one.
    act(() => {
      deleteArtifact(handle.doc, "art-1");
    });

    expect(availability()).toBe("no");
  });

  it("stays yes while any artifact remains", () => {
    const handle = openStore();
    act(() => {
      seedArtifact(handle.doc, "art-1");
      seedArtifact(handle.doc, "art-2");
    });
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );

    act(() => {
      deleteArtifact(handle.doc, "art-1");
    });

    // Emptiness is the gate, not a count: one survivor still offers search.
    expect(availability()).toBe("yes");
  });

  it("answers no for a viewer even when artifacts exist", () => {
    const handle = openStore();
    act(() => {
      seedArtifact(handle.doc, "art-1");
    });
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );
    expect(availability()).toBe("yes");

    // A read-only device never runs epic file sync, so the search RPC's disk
    // mirror never materializes; the gate hides search rather than offering a
    // permanently "still syncing" dead end.
    act(() => {
      handle.store.setState({ permissionRole: "viewer" });
    });

    expect(availability()).toBe("no");
  });

  it("answers no while the role is not yet known", () => {
    const handle = openStore();
    act(() => {
      seedArtifact(handle.doc, "art-1");
      handle.store.setState({ permissionRole: null });
    });
    render(
      <EpicSessionContext.Provider value={handle}>
        <AvailabilityProbe />
      </EpicSessionContext.Provider>,
    );
    expect(availability()).toBe("no");
  });
});
