import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oni",
  description: "Crypto paper-trading terminal. Paper only: no real orders, no real funds.",
  icons: { icon: "/brand/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="crt-screen h-dvh overflow-hidden antialiased">{children}</body>
    </html>
  );
}
