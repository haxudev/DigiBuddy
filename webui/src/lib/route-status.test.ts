import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { JsonDocument } from "./admin-config.ts";
import { CATALOGUE_DOCUMENT, PROFILES_DOCUMENT } from "./admin-config.ts";
import type { SkillCommand } from "./skill-commands.ts";

const srcUrl = new URL("../", import.meta.url).href;
const aliasLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return {
      url: new URL(specifier.slice(2) + ".ts", ${JSON.stringify(srcUrl)}).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(aliasLoader)}`, import.meta.url);

const commandsRoute = await import("../app/api/commands/route.ts");
const profilesRoute = await import("../app/api/profiles/route.ts");

type CommandsResponse = {
  status: "ready" | "unavailable";
  commands: SkillCommand[];
};

type ProfilesResponse = {
  status: "ready" | "unavailable";
  profiles: {
    name: string;
    display_name: string;
    description: string;
    skills: string[];
    tools: string[];
    mcp_servers: string[];
  }[];
};

const ENVIRONMENT_KEYS = [
  "ADMIN_ALLOW_ANONYMOUS",
  "AUTH_ALLOWED_EMAIL_DOMAINS",
  "AUTH_ALLOWED_HOME_TENANT_IDS",
  "AUTH_ALLOWED_UPN_DOMAINS",
  "AUTH_REQUIRE_CORPORATE_ACCOUNT",
  "AUTH_TENANT_ID",
  "DIGIBUDDY_CONFIG_DIR",
  "DIGIBUDDY_CONFIG_URI",
  "DIGIBUDDY_PROFILE",
  "NODE_ENV",
] as const;

const CATALOGUE: JsonDocument = {
  skills: ["agent-maturity-assess", "agent-maturity-report", "pptx"],
  tools: [],
  mcp_servers: [],
  skill_entries: [
    "agent-maturity-assess",
    "agent-maturity-report",
    "pptx",
  ].map((name) => ({
    name,
    description: `${name} description`,
    source: "packaged",
    enabled: true,
  })),
};

let directoryCounter = 0;

function configDirectory(t: TestContext): string {
  const directory = join(
    import.meta.dirname,
    `.route-status-${process.pid}-${Date.now()}-${directoryCounter++}`,
  );
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function seed(directory: string, name: string, document: JsonDocument): void {
  writeFileSync(join(directory, name), JSON.stringify(document), "utf-8");
}

function useEnvironment(
  t: TestContext,
  overrides: Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>,
): void {
  const env = process.env as Record<string, string | undefined>;
  const original = new Map(
    ENVIRONMENT_KEYS.map((key) => [key, env[key]] as const),
  );
  for (const key of ENVIRONMENT_KEYS) delete env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });
}

function principalHeaders(): Headers {
  return new Headers({
    "x-ms-client-principal": Buffer.from(
      JSON.stringify({
        identityProvider: "aad",
        userId: "route-status-tester",
        userDetails: "route-status@example.com",
      }),
    ).toString("base64"),
  });
}

function commandRequest(profile = ""): Request {
  const url = new URL("http://console.example/api/commands");
  if (profile) url.searchParams.set("profile", profile);
  return new Request(url, { headers: principalHeaders() });
}

async function commands(profile = ""): Promise<{
  response: Response;
  body: CommandsResponse;
}> {
  const response = await commandsRoute.GET(commandRequest(profile));
  return { response, body: (await response.json()) as CommandsResponse };
}

async function profiles(): Promise<ProfilesResponse> {
  return (await (await profilesRoute.GET()).json()) as ProfilesResponse;
}

function suppressRouteErrors(t: TestContext): void {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

test("the commands route treats the named deployment default as the built-in default", async (t) => {
  const directory = configDirectory(t);
  seed(directory, CATALOGUE_DOCUMENT, CATALOGUE);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: directory,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const { body } = await commands("digibuddy");

  assert.equal(body.status, "ready");
  assert.ok(body.commands.length > 0);
});

test("the commands route uses the same unrestricted fallback when no profile is requested", async (t) => {
  const directory = configDirectory(t);
  seed(directory, CATALOGUE_DOCUMENT, CATALOGUE);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: directory,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const { body } = await commands();

  assert.equal(body.status, "ready");
  assert.ok(body.commands.length > 0);
});

test("a configured profiles document keeps an unanswered command profile fail-closed", async (t) => {
  const directory = configDirectory(t);
  seed(directory, CATALOGUE_DOCUMENT, CATALOGUE);
  seed(directory, PROFILES_DOCUMENT, {
    profiles: [{ name: "slides", skills: ["pptx"] }],
  });
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: directory,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  // Once profiles exist, a name nobody answers to must not widen back to the
  // unrestricted catalogue just because it is also the deployment default.
  const { body } = await commands("digibuddy");

  assert.equal(body.status, "ready");
  assert.deepEqual(body.commands, []);
});

test("an unseeded but reachable command store is ready with no commands", async (t) => {
  const directory = configDirectory(t);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: directory,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const { body } = await commands();

  assert.equal(body.status, "ready");
  assert.deepEqual(body.commands, []);
});

test("an unreachable command store is reported as unavailable", async (t) => {
  const directory = configDirectory(t);
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "", "utf-8");
  suppressRouteErrors(t);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: blocked,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const { body } = await commands();

  assert.equal(body.status, "unavailable");
  assert.deepEqual(body.commands, []);
});

test("an unreachable profiles store keeps exactly one fallback profile usable", async (t) => {
  const directory = configDirectory(t);
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "", "utf-8");
  suppressRouteErrors(t);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: blocked,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const body = await profiles();

  assert.equal(body.status, "unavailable");
  assert.deepEqual(body.profiles, [
    {
      name: "digibuddy",
      display_name: "GTMBuddy",
      description: "Full Microsoft domain expert with every packaged capability.",
      skills: [],
      tools: [],
      mcp_servers: [],
    },
  ]);
});

test("the commands route refuses an unsigned caller before reading commands", async (t) => {
  const directory = configDirectory(t);
  seed(directory, CATALOGUE_DOCUMENT, CATALOGUE);
  useEnvironment(t, {
    DIGIBUDDY_CONFIG_DIR: directory,
    DIGIBUDDY_CONFIG_URI: undefined,
    DIGIBUDDY_PROFILE: "digibuddy",
    NODE_ENV: "test",
    ADMIN_ALLOW_ANONYMOUS: undefined,
    AUTH_ALLOWED_EMAIL_DOMAINS: undefined,
    AUTH_ALLOWED_HOME_TENANT_IDS: undefined,
    AUTH_ALLOWED_UPN_DOMAINS: undefined,
    AUTH_REQUIRE_CORPORATE_ACCOUNT: undefined,
    AUTH_TENANT_ID: undefined,
  });

  const response = await commandsRoute.GET(
    new Request("http://console.example/api/commands"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 403);
  assert.equal("commands" in body, false);
});
