import type { NextConfig } from "next";

// Req 37.1: static export, served by the Render static site from web/out.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
