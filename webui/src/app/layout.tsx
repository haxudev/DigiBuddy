import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DigiBuddy Codex",
  description: "AG-UI client for the DigiBuddy Codex Hosted Agent",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
