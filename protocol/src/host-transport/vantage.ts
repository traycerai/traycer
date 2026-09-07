/**
 * Which transport carried a connection: a socket accepted on the host's own loopback listener (`local-ws`) or one tunnelled through the cloud relay.
 * Set by the transport, never by the client, so it is the only unforgeable statement of caller locality anything downstream can read - a client-declared hostId is a claim, this is the observation.
 */
export type TransportVantage = "local-ws" | "relay";
