import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentReviewEntry } from "@traycer/protocol/host/environment-schemas";
import { HeldItemsLine } from "@/components/settings/secrets/held-items-line";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";

// The review read, the host's name and the retrospective sheet are the
// boundary: the line's own split of entries into values and commands runs for
// real.
const reads = vi.hoisted((): { entries: EnvironmentReviewEntry[] } => ({
  entries: [],
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentReviewRead: () => ({
    supported: true,
    data: { entries: reads.entries },
    isError: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
// The directory lists only hosts this window can dial; the account's host
// options name the rest.
const names = vi.hoisted(
  (): {
    directory: { label: string } | null;
    options: { hostId: string; name: string }[];
  } => ({ directory: null, options: [] }),
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => names.directory,
}));
vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({ hosts: names.options }),
}));
vi.mock("@/components/settings/move/retrospective-session", () => ({
  RetrospectiveSession: () => null,
}));

function entry(
  entryId: string,
  reason: string,
  hostId: string,
): EnvironmentReviewEntry {
  return {
    entryId,
    reason,
    kind: "variable",
    key: entryId,
    os: "macos",
    hostId,
    heldAt: 1,
  };
}

function renderLine(): void {
  const { client } = buildEnvironmentClient({ hostId: "mac", handlers: {} });
  render(<HeldItemsLine client={client} hostId="mac" />);
}

beforeEach(() => {
  reads.entries = [];
  names.directory = { label: "MacBook Pro" };
  names.options = [];
});

afterEach(cleanup);

describe("<HeldItemsLine />", () => {
  it("counts a host's held values and commands apart", () => {
    reads.entries = [
      entry("TOKEN", "credential_like_value", "mac"),
      entry("notify.sh", "executable_entry", "mac"),
      entry("GRANT", "needs_grant", "mac"),
    ];
    renderLine();

    expect(screen.getByTestId("held-items-line-mac").textContent).toBe(
      "1 value and 1 command from MacBook Pro are on hold until you choose · Review them",
    );
  });

  it("reads a single command in the singular", () => {
    reads.entries = [entry("notify.sh", "executable_entry", "mac")];
    renderLine();

    expect(screen.getByTestId("held-items-line-mac").textContent).toBe(
      "1 command from MacBook Pro is on hold until you choose · Review it",
    );
  });

  it("names a host the directory does not list from the account's host list", () => {
    names.directory = null;
    names.options = [{ hostId: "studio", name: "Studio Mac" }];
    reads.entries = [entry("TOKEN", "credential_like_value", "studio")];
    renderLine();

    expect(screen.getByTestId("held-items-line-studio").textContent).toBe(
      "1 value from Studio Mac is on hold until you choose · Review it",
    );
  });

  it("calls a host nothing names another computer, never leaves the name blank", () => {
    names.directory = null;
    names.options = [{ hostId: "studio", name: "" }];
    reads.entries = [entry("TOKEN", "credential_like_value", "studio")];
    renderLine();

    expect(screen.getByTestId("held-items-line-studio").textContent).toBe(
      "1 value from another computer is on hold until you choose · Review it",
    );
  });
});
