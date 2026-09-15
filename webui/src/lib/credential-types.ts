/**
 * Every slot a profile may bind. Closed on purpose: an open mapping would let a
 * binding shadow `PATH` or `PYTHONPATH`, which turns a credential store into a
 * way to run code.
 */
export const CREDENTIAL_SLOTS = [
  "graph_client_id",
  "graph_client_secret",
  "graph_tenant_id",
  "blob_service_uri",
  "blob_container",
  "mcp_bearer_token",
] as const;

export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

/** What a reader is allowed to know: that a slot is set, and by whom. */
export type CredentialStatus = {
  profile: string;
  slot: CredentialSlot;
  is_set: true;
  updated_at: string;
  updated_by: string;
};
