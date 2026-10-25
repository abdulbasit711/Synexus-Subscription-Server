import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { cpus: 2, serverActions: { bodySizeLimit: "1mb" } }
};

export default nextConfig;
