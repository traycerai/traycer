import type { CloudBearerSource } from "../../auth/bearer-source";
import {
  fetchEnvironmentTransport,
  type EnvironmentCloud,
} from "../environment-cloud";

/** authn's answer for one http MCP server row. */
export const MCP_SERVER_BODY = {
  server: {
    id: "server-1",
    name: "docs",
    transport: "http",
    url: "https://docs.example.test/mcp",
    command: null,
    args: [],
    env: [],
    toolToggles: { claude: { search: true } },
    credentials: {
      pat: { present: false, secretId: null },
      customHeaders: { present: false, secretId: null },
      oauth: { present: false },
    },
  },
};

export function createEnvironmentCloud(token: string | null): EnvironmentCloud {
  const bearer: CloudBearerSource = {
    kind: "cloud",
    getBearerToken: () => token,
  };
  return {
    authnBaseUrl: "https://authn.example.test",
    bearer,
    transport: fetchEnvironmentTransport,
    onOriginSignIn: () => true,
  };
}
