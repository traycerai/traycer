import { describe, expect, it } from "vitest";
import { HOST_STORE_FORMAT_FLOOR_CODE } from "@traycer/protocol/config/host-update-attempt";
import { CLI_ERROR_CODES } from "../errors";

// The Desktop classifier and the GUI banner recognise the store-format
// refusal by this code without importing the CLI. The CLI must therefore emit
// exactly the protocol constant, or the banner silently stops recognising it.
describe("store-format floor error code", () => {
  it("the CLI's HOST_STORE_FORMAT_FLOOR is the protocol constant", () => {
    expect(HOST_STORE_FORMAT_FLOOR_CODE).toBe("E_HOST_STORE_FORMAT_FLOOR");
    expect(CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR).toBe(
      HOST_STORE_FORMAT_FLOOR_CODE,
    );
  });
});
