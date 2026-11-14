import type { CloudBearerSource } from "../../auth/bearer-source";
import {
  fetchEnvironmentTransport,
  type EnvironmentCloud,
} from "../environment-cloud";

export function createEnvironmentCloud(token: string | null): EnvironmentCloud {
  const bearer: CloudBearerSource = {
    kind: "cloud",
    getBearerToken: () => token,
  };
  return {
    authnBaseUrl: "https://authn.example.test",
    bearer,
    transport: fetchEnvironmentTransport,
  };
}
