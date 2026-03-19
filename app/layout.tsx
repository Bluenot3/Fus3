import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZEN Command Center",
  description: "Mobile-first local command center for Telegram bots, site ops, and file workflows"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
