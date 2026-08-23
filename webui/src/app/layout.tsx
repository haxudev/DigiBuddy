import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HaeronClaw Codex",
  description: "AG-UI client for the HaeronClaw Codex Hosted Agent",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
