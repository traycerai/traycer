import { afterEach, describe, expect, it } from "vitest";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { installEnvProxyDispatcher } from "../env-proxy";

const originalDispatcher = getGlobalDispatcher();

afterEach(async () => {
  const current = getGlobalDispatcher();
  setGlobalDispatcher(originalDispatcher);
  if (current !== originalDispatcher) {
    await current.close();
  }
});

describe("installEnvProxyDispatcher", () => {
  it("leaves the default dispatcher alone when no proxy is configured", () => {
    expect(installEnvProxyDispatcher({})).toBeNull();
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("ignores a variable that is present but empty", () => {
    expect(
      installEnvProxyDispatcher({ HTTP_PROXY: "", https_proxy: "   " }),
    ).toBeNull();
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("installs the env proxy agent from HTTP_PROXY", () => {
    expect(
      installEnvProxyDispatcher({ HTTP_PROXY: "http://proxy.corp:8080" }),
    ).toBe("HTTP_PROXY");
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  // Managed Windows machines routinely set only the lowercase spelling, and
  // some set only the https one - the CLI's own downloads are https.
  it("installs from the lowercase and https-only spellings too", () => {
    expect(
      installEnvProxyDispatcher({ https_proxy: "http://proxy.corp:8080" }),
    ).toBe("https_proxy");
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});
