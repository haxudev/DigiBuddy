import {
  NotSignedInError,
  ownerKey,
  requirePrincipal,
} from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who the browser is signed in as.
 *
 * Easy Auth terminates sign-in in front of this app, so the server knows the
 * principal and the client does not. The client needs one thing from it:
 * conversations live in `localStorage`, a browser is shared, and showing the
 * previous person's threads to whoever signs in next is both a privacy failure
 * and a correctness one, because the next turn would resume a thread that is
 * not theirs.
 *
 * Only the display name and the opaque owner key are returned. The subject,
 * the tenant and the raw claims stay on the server.
 */
/**
 * Which providers this deployment actually offers.
 *
 * Declared rather than discovered: reading the platform's auth configuration
 * would need management permissions the app has no other reason to hold, and
 * offering a provider that is not configured sends people to a 404.
 */
function providers(): string[] {
  const declared = (process.env.AUTH_PROVIDERS ?? "aad")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => ["aad", "google", "github"].includes(entry));
  return declared.length > 0 ? [...new Set(declared)] : ["aad"];
}

function corporateOnly(): boolean {
  return process.env.AUTH_REQUIRE_CORPORATE_ACCOUNT === "true";
}

export async function GET(request: Request) {
  let principal;
  try {
    principal = requirePrincipal(request.headers);
  } catch (error) {
    if (!(error instanceof NotSignedInError)) throw error;
    const rejected = request.headers.has("x-ms-client-principal");
    return Response.json(
      {
        signedIn: false,
        providers: providers(),
        corporateOnly: corporateOnly(),
        rejected,
        ...(rejected ? { reason: error.message } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    {
      signedIn: true,
      name: principal.name,
      provider: principal.provider,
      owner: ownerKey(principal),
      providers: providers(),
      corporateOnly: corporateOnly(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
