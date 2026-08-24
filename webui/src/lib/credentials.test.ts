import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigValidationError,
  CREDENTIALS_DOCUMENT,
  buildConfigStore,
} from "./admin-config.ts";
import {
  applyCredentialChange,
  credentialStatuses,
  parseCredentials,
  readCredentialStatuses,
} from "./credentials.ts";

function withStore(run: (store: ReturnType<typeof buildConfigStore>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-credentials-"));
  return run(buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory })).finally(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
}

test("a value is never part of what a reader can see", () => {
  const statuses = credentialStatuses(
    parseCredentials({
      credentials: [
        {
          profile: "marketing",
          slot: "graph_client_secret",
          value: "super-secret",
          updated_at: "2026-08-24T00:00:00Z",
          updated_by: "admin",
        },
      ],
    }),
  );

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].is_set, true);
  assert.equal(JSON.stringify(statuses).includes("super-secret"), false);
});

test("only known slots may be bound", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () =>
        applyCredentialChange(store, {
          profile: "marketing",
          // Shadowing PATH would make the credential store a way to run code.
          slot: "PATH",
          action: "rotate",
          value: "/attacker/bin",
          by: "admin",
        }),
      ConfigValidationError,
    );
  });
});

test("a value that cannot become an environment variable is refused", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () =>
        applyCredentialChange(store, {
          profile: "marketing",
          slot: "graph_client_secret",
          action: "rotate",
          value: "has\u0000null",
          by: "admin",
        }),
      ConfigValidationError,
    );
  });
});

test("rotating one binding leaves every other profile untouched", async () => {
  await withStore(async (store) => {
    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "graph_client_secret",
      action: "rotate",
      value: "marketing-secret",
      by: "admin",
    });
    await applyCredentialChange(store, {
      profile: "support-desk",
      slot: "graph_client_secret",
      action: "rotate",
      value: "support-secret",
      by: "admin",
    });
    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "graph_client_secret",
      action: "rotate",
      value: "marketing-rotated",
      by: "admin",
    });

    const stored = parseCredentials(await store.read(CREDENTIALS_DOCUMENT));
    assert.deepEqual(
      stored.map((entry) => [entry.profile, entry.value]),
      [
        ["marketing", "marketing-rotated"],
        ["support-desk", "support-secret"],
      ],
    );
  });
});

test("clearing removes exactly one binding", async () => {
  await withStore(async (store) => {
    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "graph_client_secret",
      action: "rotate",
      value: "a",
      by: "admin",
    });
    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "mcp_bearer_token",
      action: "rotate",
      value: "b",
      by: "admin",
    });

    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "graph_client_secret",
      action: "clear",
      by: "admin",
    });

    const statuses = await readCredentialStatuses(store);
    assert.deepEqual(
      statuses.map((entry) => entry.slot),
      ["mcp_bearer_token"],
    );
  });
});

test("the status list is the only thing a read returns", async () => {
  await withStore(async (store) => {
    await applyCredentialChange(store, {
      profile: "marketing",
      slot: "graph_client_secret",
      action: "rotate",
      value: "never-readable",
      by: "admin",
    });

    const statuses = await readCredentialStatuses(store);

    assert.equal(JSON.stringify(statuses).includes("never-readable"), false);
    assert.equal(statuses[0].updated_by, "admin");
  });
});
