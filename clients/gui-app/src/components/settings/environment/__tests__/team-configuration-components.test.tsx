import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { grantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import { ConfigurationConflict } from "@/components/settings/environment/configuration-conflict";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import type { ConfigurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { TeamSecretNames } from "@/components/settings/environment/team-secret-names";

afterEach(cleanup);

describe("TeamSecretNames", () => {
  it("lists names with their state and renders no buttons", () => {
    render(
      <TeamSecretNames
        secrets={[
          { id: "sec-1", name: "OPENAI_API_KEY", revoked: false },
          { id: "sec-2", name: "OLD_TOKEN", revoked: true },
        ]}
      />,
    );

    expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
    expect(screen.getByText("Removing · no longer usable")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  // NEW-154-24: the list carries no heading of its own and makes no claim
  // about who may replace a secret; the page's standing line says the role.
  it("heads nothing and claims nothing about editors", () => {
    render(
      <TeamSecretNames
        secrets={[{ id: "sec-1", name: "OPENAI_API_KEY", revoked: false }]}
      />,
    );

    expect(screen.queryByText("Editors can replace these")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Secrets" })).toBeNull();
  });

  it("says there are none rather than showing an empty list", () => {
    render(<TeamSecretNames secrets={[]} />);

    expect(screen.getByText("No secrets.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

/**
 * NEW-154-24: the access refusal belongs to the moment of a stale write. Once
 * the page has read the role that refused it, the page's standing viewer line
 * says it instead, so the refusal does not stand permanently above the list.
 */
describe("ConfigurationWriteFeedback", () => {
  function renderFeedback(
    role: "editor" | "viewer",
    issue: ConfigurationWriteIssue,
  ): void {
    render(
      <ConfigurationSourceContext.Provider
        value={{
          kind: "pool",
          configuration: "team",
          environmentId: "env-a",
          roomId: "room-a",
          providerHandle: null,
          effectiveRole: grantedEnvironmentRole(role),
        }}
      >
        <ConfigurationWriteFeedback issue={issue} />
      </ConfigurationSourceContext.Provider>,
    );
  }

  it("says the write was refused while the page still offers the editor's form", () => {
    renderFeedback("editor", { kind: "forbidden" });
    expect(screen.getByRole("status").textContent).toBe(
      "You no longer have access to change these settings.",
    );
  });

  it("stops saying it once the page has read the role that refused the write", () => {
    renderFeedback("viewer", { kind: "forbidden" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a refusal that names its own reason, whatever the role", () => {
    renderFeedback("viewer", {
      kind: "refused",
      line: "This host is offline.",
    });
    expect(screen.getByRole("status").textContent).toBe(
      "This host is offline.",
    );
  });
});

describe("ConfigurationConflict", () => {
  it("names who changed the value", () => {
    render(<ConfigurationConflict changedBy="Grace" />);
    expect(screen.getByRole("status").textContent).toBe(
      "Changed by Grace a moment ago",
    );
  });

  it("falls back to another member when the author is unknown", () => {
    render(<ConfigurationConflict changedBy={null} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Changed by another member a moment ago",
    );
  });
});
