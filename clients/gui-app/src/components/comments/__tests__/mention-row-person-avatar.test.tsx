import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { MentionSuggestionList } from "@/components/comments/collaborator-mention-suggestion";
import {
  collaboratorEntry,
  collaboratorsResponse,
  createPersonAvatarHarness,
  type PersonAvatarHarness,
} from "./person-avatar-test-support";

let harness: PersonAvatarHarness;

beforeEach(() => {
  harness = createPersonAvatarHarness();
  stubImmediateImage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.dispose();
});

function option(name: string): HTMLElement {
  return screen.getByRole("option", { name: new RegExp(name) });
}

describe("<MentionSuggestionList /> candidate pictures", () => {
  it("draws the picture of a candidate in the cached collaborators list and initials for one that is not", async () => {
    harness.publishCollaborators(
      collaboratorsResponse([
        collaboratorEntry("user-2", {
          displayName: "Grace Hopper",
          avatarUrl: "https://example.com/grace.png",
        }),
      ]),
    );

    render(
      harness.wrap(
        <MentionSuggestionList
          items={[
            { userId: "user-2", displayName: "Grace Hopper", email: "" },
            { userId: "user-3", displayName: "Alan Turing", email: "" },
          ]}
          command={vi.fn()}
          getReferenceClientRect={null}
        />,
      ),
    );

    const known = within(option("Grace Hopper")).getByTestId("person-avatar");
    await waitFor(() => {
      expect(known.querySelector("img")?.getAttribute("src")).toBe(
        "https://example.com/grace.png",
      );
    });
    const unknown = within(option("Alan Turing")).getByTestId("person-avatar");
    expect(unknown.textContent).toBe("AT");
    expect(unknown.querySelector("img")).toBeNull();
  });
});
