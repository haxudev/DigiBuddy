import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  AdminAuthError,
  createAdminSession,
  requireAdmin,
  verifyAdminCredentials,
} from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export async function GET(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    return Response.json(
      { authenticated: true, name: principal.name },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return Response.json(
        { authenticated: false },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!verifyAdminCredentials(username, password)) {
    return Response.json(
      { error: "Invalid administrator username or password." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const token = createAdminSession(username);
  console.info(`administrator signed in by=password:${username.trim()}`);
  return Response.json(
    { authenticated: true, name: username.trim() },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": cookie(token, ADMIN_SESSION_MAX_AGE_SECONDS),
      },
    },
  );
}

export async function DELETE() {
  return Response.json(
    { authenticated: false },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("", 0),
      },
    },
  );
}
