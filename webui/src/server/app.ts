import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import * as agent from "./routes/agent/route.ts";
import * as me from "./routes/me/route.ts";
import * as profiles from "./routes/profiles/route.ts";
import * as commands from "./routes/commands/route.ts";
import * as artifacts from "./routes/artifacts/[id]/[name]/route.ts";
import * as transcribe from "./routes/transcribe/route.ts";
import * as adminSession from "./routes/admin/session/route.ts";
import * as adminConfig from "./routes/admin/config/route.ts";
import * as adminCredentials from "./routes/admin/credentials/route.ts";
import * as adminCommands from "./routes/admin/commands/route.ts";
import * as adminSkillPolicy from "./routes/admin/skill-policy/route.ts";
import * as adminSkills from "./routes/admin/skills/route.ts";
import * as adminSkillImport from "./routes/admin/skills/import/route.ts";
import * as adminSkillPreview from "./routes/admin/skills/preview/route.ts";
import * as runtimeDocuments from "./routes/runtime/documents/[name]/route.ts";
import * as runtimeBundles from "./routes/runtime/bundles/[name]/[sha256]/route.ts";
import * as runtimeArtifacts from "./routes/runtime/artifacts/[owner]/[id]/[name]/route.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type Handler<Params> = (
  request: Request,
  context: { params: Promise<Params> },
) => Response | Promise<Response>;

function route<Params extends Record<string, string>>(
  path: string,
  handlers: Partial<Record<Method, Handler<Params>>>,
) {
  const methods = Object.keys(handlers) as Method[];
  const allowed = new Set<Method>([...methods, "OPTIONS"]);
  if (handlers.GET) allowed.add("HEAD");
  return {
    path,
    methods,
    handle(context: Context) {
      const method = context.req.method as Method;
      const handler = handlers[method] ?? (method === "HEAD" ? handlers.GET : undefined);
      if (handler) {
        return handler(context.req.raw, {
          params: Promise.resolve(context.req.param() as Params),
        });
      }
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: [...allowed].sort().join(", ") },
        });
      }
      return new Response(null, { status: 405 });
    },
  };
}

export const apiRoutes = [
  route("/api/agent", agent),
  route("/api/me", me),
  route("/api/profiles", profiles),
  route("/api/commands", commands),
  route("/api/artifacts/:id/:name", artifacts),
  route("/api/transcribe", transcribe),
  route("/api/admin/session", adminSession),
  route("/api/admin/config", adminConfig),
  route("/api/admin/credentials", adminCredentials),
  route("/api/admin/commands", adminCommands),
  route("/api/admin/skill-policy", adminSkillPolicy),
  route("/api/admin/skills", adminSkills),
  route("/api/admin/skills/import", adminSkillImport),
  route("/api/admin/skills/preview", adminSkillPreview),
  route("/api/runtime/documents/:name", runtimeDocuments),
  route("/api/runtime/bundles/:name/:sha256", runtimeBundles),
  route("/api/runtime/artifacts/:owner/:id/:name", runtimeArtifacts),
];

export function createApp({ staticRoot }: { staticRoot?: string } = {}) {
  const app = new Hono({ strict: false });
  app.onError(() => {
    console.error("Unexpected BFF request failure.");
    return Response.json({ error: "Internal server error." }, { status: 500 });
  });
  for (const { path, handle } of apiRoutes) app.all(path, handle);

  // Easy Auth owns /.auth; neither it nor unknown API paths are SPA routes.
  app.all("/api/*", () => new Response(null, { status: 404 }));
  app.all("/api", () => new Response(null, { status: 404 }));
  app.all("/.auth/*", () => new Response(null, { status: 404 }));
  app.all("/.auth", () => new Response(null, { status: 404 }));
  if (staticRoot) {
    app.on(["GET", "HEAD"], "*", serveStatic({ root: staticRoot }));
    const index = serveStatic({ root: staticRoot, path: "index.html" });
    app.get("/", index);
    app.get("/admin", index);
  }
  return app;
}
