/**
 * Which transport carried a connection: a socket accepted on the host's own
 * loopback listener (`local-ws`) or one tunnelled through the cloud relay.
 *
 * Set by the transport, never by the client, so it is the only unforgeable
 * statement of caller locality anything downstream can read - a client-declared
 * hostId is a claim, this is the observation. One definition, because a
 * resolver context, a stream subscriber and the doctor's trivially-green rule
 * all have to mean the same two words by it.
 */
export type TransportVantage = "local-ws" | "relay";
