/**
 * Add-to-artifact: retain/prepare → Y node insert → finish commit →
 * reference index handoff, plus rollback on mid-failure and remote
 * snapshot failure that leaves no broken node.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { AddImageToArtifactButton } from "@/components/artifacts/add-image-to-artifact-button";

const prepareBytes = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      operationId: "op-client",
      attachmentHash: "hash-client",
      mediaType: "image/png" as const,
      src: "images/hash-client.png",
    }),
  ),
);
const prepareRemote = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      operationId: "op-remote",
      attachmentHash: "hash-remote",
      mediaType: "image/png" as const,
      src: "images/hash-remote.png",
    }),
  ),
);
const finish = vi.hoisted(() =>
  vi.fn((): Promise<boolean> => Promise.resolve(true)),
);

const acquireArtifactBodyLease = vi.hoisted(() =>
  vi.fn(() => {
    return () => {};
  }),
);
const getArtifactFragment = vi.hoisted(() =>
  vi.fn((): Y.XmlFragment | null => null),
);

vi.mock("@/hooks/artifacts/use-artifact-image-operations", () => ({
  useArtifactImageOperations: () => ({
    supported: true,
    prepareBytes,
    prepareRemote,
    finish,
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
  useEpicArtifactRecords: () => [
    {
      id: "artifact-a",
      name: "Spec A",
      type: "spec",
    },
  ],
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({
        acquireArtifactBodyLease,
        getArtifactFragment,
      }),
    },
  }),
}));

vi.mock("@/lib/artifacts/node-display", () => ({
  isEpicArtifactKind: () => true,
}));

let fragmentDoc: Y.Doc;
let fragment: Y.XmlFragment;

function imageNodeCount(): number {
  return fragment
    .toArray()
    .filter((node) => node instanceof Y.XmlElement && node.nodeName === "image")
    .length;
}

function clearFragment(): void {
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
}

afterEach(() => {
  cleanup();
  clearFragment();
  prepareBytes.mockReset();
  prepareRemote.mockReset();
  finish.mockReset();
  acquireArtifactBodyLease.mockClear();
  getArtifactFragment.mockClear();
  getArtifactFragment.mockImplementation(() => fragment);
  prepareBytes.mockResolvedValue({
    ok: true as const,
    operationId: "op-client",
    attachmentHash: "hash-client",
    mediaType: "image/png" as const,
    src: "images/hash-client.png",
  });
  prepareRemote.mockResolvedValue({
    ok: true as const,
    operationId: "op-remote",
    attachmentHash: "hash-remote",
    mediaType: "image/png" as const,
    src: "images/hash-remote.png",
  });
  finish.mockResolvedValue(true);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fragmentDoc = new Y.Doc();
  fragment = fragmentDoc.getXmlFragment("artifact-body");
  getArtifactFragment.mockImplementation(() => fragment);
  const pngBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(pngBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      ),
    ),
  );
});

describe("AddImageToArtifactButton", () => {
  it("runs prepare → insert → finish(commit) for a client-backed image", async () => {
    render(
      <AddImageToArtifactButton
        source={{ kind: "client", url: "blob:http://localhost/img" }}
        alt="from chat"
        className={undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /add image to artifact/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /spec a/i }));

    await waitFor(() => {
      expect(finish).toHaveBeenCalledWith("artifact-a", "op-client", true);
    });
    expect(prepareBytes).toHaveBeenCalledTimes(1);
    expect(imageNodeCount()).toBe(1);
    expect(acquireArtifactBodyLease).toHaveBeenCalledWith("artifact-a");
  });

  it("rolls back the Y node and aborts the operation when finish fails mid-sequence", async () => {
    finish.mockResolvedValueOnce(false);
    render(
      <AddImageToArtifactButton
        source={{ kind: "client", url: "blob:http://localhost/img" }}
        alt="from chat"
        className={undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /add image to artifact/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /spec a/i }));

    expect(await screen.findByText(/could not be committed/i)).toBeTruthy();
    expect(imageNodeCount()).toBe(0);
    expect(finish).toHaveBeenCalledWith("artifact-a", "op-client", true);
  });

  it("surfaces remote HTTPS snapshot-on-add failure in the picker and leaves no broken node", async () => {
    prepareRemote.mockRejectedValueOnce(
      new Error("Remote image could not be fetched."),
    );
    render(
      <AddImageToArtifactButton
        source={{
          kind: "remote",
          url: "https://cdn.example.com/shot.png",
        }}
        alt="remote"
        className={undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /add image to artifact/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /spec a/i }));

    expect(await screen.findByText(/could not be fetched/i)).toBeTruthy();
    expect(prepareRemote).toHaveBeenCalledWith(
      "https://cdn.example.com/shot.png",
    );
    expect(imageNodeCount()).toBe(0);
    expect(finish).not.toHaveBeenCalledWith(
      "artifact-a",
      expect.anything(),
      true,
    );
  });

  it("aborts a prepared remote op when body lease insert fails after prepare", async () => {
    getArtifactFragment.mockReturnValueOnce(null);
    render(
      <AddImageToArtifactButton
        source={{
          kind: "remote",
          url: "https://cdn.example.com/shot.png",
        }}
        alt="remote"
        className={undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /add image to artifact/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /spec a/i }));

    expect(await screen.findByText(/not available for editing/i)).toBeTruthy();
    expect(prepareRemote).toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("artifact-a", "op-remote", false);
    expect(imageNodeCount()).toBe(0);
  });
});
