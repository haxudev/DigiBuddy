"use client";

import styles from "./sign-in.module.css";

/** Providers this deployment offers, in the order they are shown. */
const LABELS: Record<string, { name: string; mark: string }> = {
  aad: { name: "Microsoft", mark: "▦" },
  google: { name: "Google", mark: "G" },
  github: { name: "GitHub", mark: "◐" },
};

/**
 * The gate in front of the console.
 *
 * Easy Auth is configured to allow anonymous requests at the platform, because
 * making it redirect would pick one provider for everyone. The choice belongs
 * here instead, and the server refuses unauthenticated work regardless of what
 * this component does.
 */
export default function SignIn({ providers }: { providers: string[] }) {
  const offered = providers.filter((entry) => entry in LABELS);

  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <span className={styles.mark} aria-hidden="true">
          ⌁
        </span>
        <h1>DigiBuddy</h1>
        <p>
          Sign in to start a conversation. Your conversations and the files they
          produce are private to the account you sign in with.
        </p>

        <div className={styles.providers}>
          {offered.map((provider) => (
            <a
              key={provider}
              className={styles.provider}
              href={`/.auth/login/${provider}?post_login_redirect_uri=/`}
            >
              <span className={styles.providerMark} aria-hidden="true">
                {LABELS[provider].mark}
              </span>
              Continue with {LABELS[provider].name}
            </a>
          ))}
        </div>

        {offered.length === 0 && (
          <p className={styles.note}>
            No sign-in provider is configured for this deployment.
          </p>
        )}

        <p className={styles.note}>
          Signing in with a different provider creates a separate account, even
          for the same person — this console cannot tell that they are the same.
        </p>
      </section>
    </main>
  );
}
