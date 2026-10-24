import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import {
  closeSandboxDetails,
  openSandboxDetails,
} from "@/stores/sandboxes/sandbox-details-store";

const list = vi.hoisted(() => ({
  refetch: vi.fn(() => Promise.resolve()),
}));

// The list read failed: no data, and the query says so.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: undefined,
    isError: true,
    isFetching: false,
    refetch: list.refetch,
  }),
}));

afterEach(() => {
  act(() => {
    closeSandboxDetails();
  });
  cleanup();
});

describe("<SandboxDetailsDrawerHost />", () => {
  it("says a failed list read failed and reads it again on Retry, instead of loading for ever", () => {
    render(<SandboxDetailsDrawerHost />);
    act(() => {
      openSandboxDetails("sbx-1");
    });

    expect(screen.getByText(SANDBOX_LIST_FAILED)).toBeDefined();
    expect(screen.queryByText("Loading this sandbox's details…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(list.refetch).toHaveBeenCalledTimes(1);
  });
});
