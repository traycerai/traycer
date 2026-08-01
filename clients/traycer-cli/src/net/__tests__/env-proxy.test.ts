import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { installEnvProxyDispatcher } from "../env-proxy";

const originalDispatcher = getGlobalDispatcher();

/**
 * A real tunneling proxy that records the authority of every CONNECT it is
 * asked for, and then answers the tunneled request itself.
 *
 * This is what makes the routing assertions real rather than shape checks.
 * undici tunnels by default (`proxyTunnel` is `true` even for `http:` origins),
 * so a recorded authority PROVES the dispatcher routed through the configured
 * proxy, and an empty recording proves it went direct. Answering inside the
 * tunnel keeps the assertions on a returned body rather than on the shape of
 * whatever error a half-open socket produces.
 */
async function withRecordingProxy(
  run: (args: {
    readonly url: string;
    readonly tunnelled: () => readonly string[];
  }) => Promise<void>,
): Promise<void> {
  const tunnelled: string[] = [];
  const origin: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxied");
  });
  const proxy: Server = createServer((_req, res) => {
    res.writeHead(501).end();
  });
  proxy.on("connect", (req, socket, head) => {
    tunnelled.push(req.url ?? "");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    // Hand the tunneled socket to a plain HTTP server: from here the client
    // speaks ordinary HTTP down the tunnel, exactly as it would to the origin.
    origin.emit("connection", socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  try {
    await run({
      url: `http://127.0.0.1:${port}`,
      tunnelled: () => tunnelled,
    });
  } finally {
    proxy.closeAllConnections();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

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

  // The seam has to be honest: `EnvHttpProxyAgent` falls back to `process.env`
  // for every option it is not given, so an installer that only READ the
  // injected env would install an agent routing on the runner's environment
  // instead. Pointing `process.env` at a dead port proves which one won.
  it("routes on the injected environment, not on process.env", async () => {
    await withRecordingProxy(async ({ url, tunnelled }) => {
      const restore = process.env.HTTP_PROXY;
      // Port 1 is reserved and never listening: if this value is the one that
      // reaches the agent, the fetch below cannot succeed.
      process.env.HTTP_PROXY = "http://127.0.0.1:1";
      try {
        expect(installEnvProxyDispatcher({ HTTP_PROXY: url })).toBe(
          "HTTP_PROXY",
        );
        const response = await fetch("http://host.invalid/keys");
        expect(await response.text()).toBe("proxied");
        expect(tunnelled()).toEqual(["host.invalid:80"]);
      } finally {
        if (restore === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = restore;
      }
    });
  });

  // NO_PROXY is the half that decides a request must NOT be tunnelled. On a
  // managed workstation it is routinely the reason the loopback host and the
  // corporate proxy can coexist, so it has to come from the same source.
  it("honours NO_PROXY from the injected environment", async () => {
    await withRecordingProxy(async ({ url, tunnelled }) => {
      expect(
        installEnvProxyDispatcher({
          HTTP_PROXY: url,
          NO_PROXY: "host.invalid",
        }),
      ).toBe("HTTP_PROXY");
      // Excluded, so it is resolved directly - and `host.invalid` does not
      // resolve, which is exactly the proof that the proxy was bypassed.
      await expect(fetch("http://host.invalid/keys")).rejects.toThrow();
      expect(tunnelled()).toEqual([]);
    });
  });
});
