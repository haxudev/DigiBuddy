import {
  commandPatch,
  commandRevision,
  readCommandsVersioned,
  removeCommandOverride,
  upsertCommandOverride,
  writeCommands,
} from "@/lib/admin-commands";
import { requireAdmin } from "@/lib/admin-auth";
import {
  ConfigConflictError,
  ConfigValidationError,
  buildConfigStore,
} from "@/lib/admin-config";
import { audit, failure } from "@/lib/skill-import";
import { normaliseCommands } from "@/lib/skill-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function conflict(error: ConfigConflictError): ConfigConflictError {
  error.message =
    error.message || "Slash commands changed while you were editing; reload and try again.";
  return error;
}

export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    const { commands, revision } = await readCommandsVersioned(
      buildConfigStore(),
    );
    return Response.json(
      { commands, revision },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as unknown;

    const expectedRevision = commandRevision(body);
    // Older admin consoles did not send a revision. Keep those writes
    // unconditional for compatibility, but every current UI mutation includes
    // one so concurrent edits receive a 409 instead of overwriting silently.
    const store = buildConfigStore();
    const commands = await writeCommands(
      store,
      normaliseCommands(body),
      expectedRevision,
    ).catch((error) => {
      if (error instanceof ConfigConflictError) throw conflict(error);
      throw error;
    });
    audit(principal, "curated commands", "commands.json");
    const { revision } = await readCommandsVersioned(store);
    return Response.json({ commands, revision });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    });
    const patch = commandPatch(body);
    const expectedRevision = commandRevision(body);

    const store = buildConfigStore();
    const { commands: current } = await readCommandsVersioned(store);
    const commands = await writeCommands(
      store,
      upsertCommandOverride(current, patch),
      expectedRevision,
    ).catch((error) => {
      if (error instanceof ConfigConflictError) throw conflict(error);
      throw error;
    });
    audit(principal, "curated command", patch.name);
    const { revision } = await readCommandsVersioned(store);
    return Response.json({
      command: commands.find((command) => command.name === patch.name),
      commands,
      revision,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const searchParams = new URL(request.url).searchParams;
    const name = searchParams.get("name");
    const expectedRevision = searchParams.get("revision") ?? undefined;

    const store = buildConfigStore();
    const { commands: current } = await readCommandsVersioned(store);
    const removed = removeCommandOverride(current, name);
    const commands = await writeCommands(
      store,
      removed.commands,
      expectedRevision,
    ).catch((error) => {
      if (error instanceof ConfigConflictError) throw conflict(error);
      throw error;
    });
    audit(principal, "reverted command override", removed.name);
    const { revision } = await readCommandsVersioned(store);
    return Response.json({
      commands,
      revision,
      reverted: removed.name,
      message:
        "The override was deleted. Any packaged or deployed skill remains available through auto-discovery.",
    });
  } catch (error) {
    return failure(error);
  }
}
