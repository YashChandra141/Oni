import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oni",
  description: "Crypto paper-trading terminal. Paper only: no real orders, no real funds.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="crt-screen min-h-screen antialiased">{children}</body>
    </html>
  );
}
