import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBlobObjectUrl } from "@/hooks/files/use-blob-object-url";

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => {
      const url = `blob:test-${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useBlobObjectUrl", () => {
  it("revokes every URL it makes exactly once under StrictMode, and never hands out a revoked one", async () => {
    const blob = new Blob(["bytes"]);
    const view = renderHook(() => useBlobObjectUrl(blob), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(view.result.current).not.toBeNull());
    const live = view.result.current;
    expect(revoked).not.toContain(live);
    expect(created).toContain(live);

    view.unmount();

    expect([...revoked].sort()).toEqual([...created].sort());
  });

  it("answers null for a new Blob until its own URL exists", async () => {
    const view = renderHook((blob: Blob) => useBlobObjectUrl(blob), {
      initialProps: new Blob(["one"]),
    });
    await waitFor(() => expect(view.result.current).not.toBeNull());
    const first = view.result.current;

    view.rerender(new Blob(["two"]));

    expect(view.result.current).toBeNull();
    await waitFor(() => expect(view.result.current).not.toBeNull());
    expect(view.result.current).not.toBe(first);
    expect(revoked).toEqual([first]);
  });
});
