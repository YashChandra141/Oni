import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/shell/AppShell";
import "./globals.css";
import "../styles/oni-theme.css";

export const metadata: Metadata = {
  title: "Oni",
  description: "Crypto paper-trading terminal. Paper only: no real orders, no real funds.",
  icons: { icon: "/brand/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#050507",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="oni">
      <body className="crt-screen h-dvh overflow-hidden antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
