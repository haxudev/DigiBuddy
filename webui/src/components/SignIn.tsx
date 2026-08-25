"use client";

import styles from "./sign-in.module.css";

/** Providers this deployment offers, in the order they are shown. */
const LABELS: Record<string, { name: string; mark: string }> = {
  aad: { name: "Microsoft", mark: "▦" },
  google: { name: "Google", mark: "G" },
  github: { name: "GitHub", mark: "◐" },
};

function providerDescription(provider: string, corporateOnly: boolean): string {
  if (provider === "aad" && corporateOnly) {
    return "Use your Microsoft employee account";
  }
  return `Sign in securely with ${LABELS[provider].name}`;
}

/**
 * The gate in front of the console.
 *
 * Easy Auth is configured to allow anonymous requests at the platform, because
 * making it redirect would pick one provider for everyone. The choice belongs
 * here instead, and the server refuses unauthenticated work regardless of what
 * this component does.
 */
export default function SignIn({
  providers,
  corporateOnly = false,
  rejected = false,
  reason = "",
}: {
  providers: string[];
  corporateOnly?: boolean;
  rejected?: boolean;
  reason?: string;
}) {
  const offered = providers.filter((entry) => entry in LABELS);

  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <span className={styles.mark} aria-hidden="true">
          ⌁
        </span>
        <h1>GTMBuddy</h1>
        <p>
          {corporateOnly
            ? "Sign in with your Microsoft work account. Personal Microsoft accounts such as Hotmail are not accepted."
            : "Sign in to start a conversation. Your conversations and the files they produce are private to the account you sign in with."}
        </p>

        {rejected && (
          <div className={styles.warning} role="alert">
            <strong>This account cannot access GTMBuddy.</strong>
            <span>
              {reason ||
                "Sign out and choose your Microsoft employee account."}
            </span>
          </div>
        )}

        <div className={styles.providers}>
          {offered.map((provider) => {
            const parameters = new URLSearchParams({
              post_login_redirect_uri: "/",
            });
            if (corporateOnly && provider === "aad") {
              parameters.set("prompt", "select_account");
              parameters.set("domain_hint", "microsoft.com");
            }
            return (
              <a
                key={provider}
                className={styles.provider}
                href={`/.auth/login/${provider}?${parameters}`}
              >
                <span className={styles.providerMark} aria-hidden="true">
                  {LABELS[provider].mark}
                </span>
                <span className={styles.providerText}>
                  <strong>
                    Continue with {LABELS[provider].name}
                    {corporateOnly && provider === "aad" ? " work account" : ""}
                  </strong>
                  <small>{providerDescription(provider, corporateOnly)}</small>
                </span>
                <span className={styles.providerArrow} aria-hidden="true">
                  →
                </span>
              </a>
            );
          })}
        </div>

        {rejected && (
          <a
            className={styles.switchAccount}
            href="/.auth/logout?post_logout_redirect_uri=/"
          >
            Sign out and clear the current account
          </a>
        )}

        {offered.length === 0 && (
          <p className={styles.note}>
            No sign-in provider is configured for this deployment.
          </p>
        )}

        {!corporateOnly && (
          <p className={styles.note}>
            Signing in with a different provider creates a separate account, even
            for the same person — this console cannot tell that they are the same.
          </p>
        )}
      </section>
    </main>
  );
}
