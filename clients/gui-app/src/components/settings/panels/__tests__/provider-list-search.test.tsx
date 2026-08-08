import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderListSearch,
  ProviderListSearchEmptyState,
} from "@/components/settings/panels/provider-list-search";

afterEach(() => {
  cleanup();
});

describe("<ProviderListSearch />", () => {
  it("labels the field from the resource name and stays silent while inactive", () => {
    render(
      <ProviderListSearch
        query=""
        onQueryChange={() => undefined}
        resultCount={3}
        resourceLabel="servers"
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Search servers" }),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(
      screen.queryByRole("button", { name: "Clear servers search" }),
    ).toBeNull();
  });

  it("announces result counts and offers a clear control once a query is active", () => {
    const onQueryChange = vi.fn();
    render(
      <ProviderListSearch
        query="ctx"
        onQueryChange={onQueryChange}
        resultCount={2}
        resourceLabel="servers"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("2 servers shown.");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear servers search" }),
    );
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("uses the singular form for one result and a no-match line for zero", () => {
    const { rerender } = render(
      <ProviderListSearch
        query="pdf"
        onQueryChange={() => undefined}
        resultCount={1}
        resourceLabel="plugins"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("1 plugin shown.");

    rerender(
      <ProviderListSearch
        query="zzz"
        onQueryChange={() => undefined}
        resultCount={0}
        resourceLabel="plugins"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("No plugins match.");
  });

  it("forwards typed characters to the query callback", () => {
    const onQueryChange = vi.fn();
    render(
      <ProviderListSearch
        query=""
        onQueryChange={onQueryChange}
        resultCount={0}
        resourceLabel="skills"
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), {
      target: { value: "find" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("find");
  });
});

describe("<ProviderListSearchEmptyState />", () => {
  it("quotes the trimmed query in the unmatched-list copy", () => {
    render(
      <ProviderListSearchEmptyState
        query="  contxt  "
        resourceLabel="servers"
      />,
    );

    expect(screen.getByText("No servers match “contxt”.")).toBeDefined();
  });
});
