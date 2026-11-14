import { describe, expect, it } from "vitest";
import {
  messageNotAcceptedCircumstance,
  messageNotAcceptedNoticeCircumstance,
} from "../rejected-frame-reason";

describe("messageNotAcceptedCircumstance", () => {
  it.each(["That profile no longer exists. Choose a profile.", "", null])(
    "uses the fixed removed-profile phrase when the computer reason is %j",
    (reason) => {
      expect(messageNotAcceptedCircumstance("removed-by-person", reason)).toBe(
        "A message was not accepted (Was removed)",
      );
    },
  );

  it("keeps the reason wording under a different code", () => {
    expect(
      messageNotAcceptedCircumstance(
        "RPC_ERROR",
        "That profile no longer exists. Choose a profile.",
      ),
    ).toBe(
      "A message was not accepted (That profile no longer exists. Choose a profile)",
    );
  });
});

describe("messageNotAcceptedNoticeCircumstance", () => {
  it("puts Was removed above the notice sentence for the removed-profile code", () => {
    expect(
      messageNotAcceptedNoticeCircumstance(
        "removed-by-person",
        "That profile no longer exists. Choose a profile.",
      ),
    ).toBe("Was removed\nA message was not accepted");
  });

  it("keeps the parenthetical reason under a different code", () => {
    expect(
      messageNotAcceptedNoticeCircumstance(
        "RPC_ERROR",
        "That profile no longer exists. Choose a profile.",
      ),
    ).toBe(
      "A message was not accepted (That profile no longer exists. Choose a profile)",
    );
  });
});
