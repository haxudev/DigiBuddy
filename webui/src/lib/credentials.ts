/**
 * Credentials bound to one agent profile.
 *
 * Kept apart from `profiles.json` on purpose. That document is projected to
 * every chat user through `/api/profiles`, so a secret stored inside it would
 * be one careless projection away from being public. This document is never
 * returned by a read API at all: callers learn which slots are set, never what
 * they are set to.
 *
 * Merging is by `(profile, slot)`, never by array position. The profiles editor
 * saves a whole array, so a rename or a reorder would otherwise move a secret
 * onto a different agent.
 *
 * Mirrors `hosted-agent/codex_adapter/credentials.py`.
 */

import {
  ConfigValidationError,
  CREDENTIALS_DOCUMENT,
  SCHEMA_FIELD,
  SCHEMA_VERSION,
  type ConfigStore,
  type DocumentRevision,
  type JsonDocument,
} from "./admin-config.ts";

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

export type StoredCredential = {
  profile: string;
  slot: CredentialSlot;
  value: string;
  updated_at: string;
  updated_by: string;
};

/** What a reader is allowed to know: that a slot is set, and by whom. */
export type CredentialStatus = {
  profile: string;
  slot: CredentialSlot;
  is_set: true;
  updated_at: string;
  updated_by: string;
};

export type CredentialAction = "rotate" | "clear";

const MAX_VALUE_BYTES = 8 * 1024;
const PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isSlot(value: string): value is CredentialSlot {
  return (CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

export function parseCredentials(input: unknown): StoredCredential[] {
  const raw =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const entries = raw.credentials;
  if (!Array.isArray(entries)) return [];

  const byKey = new Map<string, StoredCredential>();
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const profile = text(entry.profile);
    const slot = text(entry.slot).toLowerCase();
    const value = typeof entry.value === "string" ? entry.value : "";
    if (!PROFILE_NAME.test(profile) || !isSlot(slot) || !value) continue;
    byKey.set(`${profile}\u0000${slot}`, {
      profile,
      slot,
      value,
      updated_at: text(entry.updated_at),
      updated_by: text(entry.updated_by),
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.profile.localeCompare(right.profile) ||
      left.slot.localeCompare(right.slot),
  );
}

/** The only shape that may leave the server. */
export function credentialStatuses(
  credentials: StoredCredential[],
): CredentialStatus[] {
  return credentials.map(({ profile, slot, updated_at, updated_by }) => ({
    profile,
    slot,
    is_set: true,
    updated_at,
    updated_by,
  }));
}

export function assertBindable(profile: string, slot: string): CredentialSlot {
  if (!PROFILE_NAME.test(profile)) {
    throw new ConfigValidationError(
      `Profile names may only contain lowercase letters, digits and dashes: ${profile}`,
    );
  }
  if (!isSlot(slot)) {
    throw new ConfigValidationError(
      `Unknown credential slot: ${slot}. Bindable slots are ${CREDENTIAL_SLOTS.join(", ")}.`,
    );
  }
  return slot;
}

function assertUsableValue(value: string): string {
  if (!value) {
    throw new ConfigValidationError("A credential value must not be empty.");
  }
  if (value.includes("\u0000")) {
    throw new ConfigValidationError(
      "A credential value must not contain a null byte; it becomes an environment variable.",
    );
  }
  if (Buffer.byteLength(value, "utf-8") > MAX_VALUE_BYTES) {
    throw new ConfigValidationError(
      `A credential value may be at most ${MAX_VALUE_BYTES} bytes.`,
    );
  }
  return value;
}

/**
 * Apply one change and write the document conditionally.
 *
 * `rotate` replaces exactly one binding and `clear` removes exactly one, so a
 * concurrent edit to a different profile cannot be lost by this write, and a
 * conflicting edit to the same one is reported rather than silently applied.
 */
export async function applyCredentialChange(
  store: ConfigStore,
  change: {
    profile: string;
    slot: string;
    action: CredentialAction;
    value?: string;
    by: string;
  },
): Promise<CredentialStatus[]> {
  const slot = assertBindable(change.profile, change.slot);
  const { document, revision } = await store.readVersioned(CREDENTIALS_DOCUMENT);
  const current = parseCredentials(document);
  const others = current.filter(
    (entry) => entry.profile !== change.profile || entry.slot !== slot,
  );

  const next =
    change.action === "clear"
      ? others
      : [
          ...others,
          {
            profile: change.profile,
            slot,
            value: assertUsableValue(change.value ?? ""),
            updated_at: new Date().toISOString(),
            updated_by: change.by,
          },
        ];

  await writeCredentials(store, next, revision);
  return credentialStatuses(parseCredentials({ credentials: next }));
}

export async function readCredentialStatuses(
  store: ConfigStore,
): Promise<CredentialStatus[]> {
  return credentialStatuses(
    parseCredentials(await store.read(CREDENTIALS_DOCUMENT)),
  );
}

async function writeCredentials(
  store: ConfigStore,
  credentials: StoredCredential[],
  expectedRevision: DocumentRevision,
): Promise<void> {
  const document: JsonDocument = {
    [SCHEMA_FIELD]: SCHEMA_VERSION,
    credentials: parseCredentials({ credentials }),
  };
  await store.write(CREDENTIALS_DOCUMENT, document, expectedRevision);
}
