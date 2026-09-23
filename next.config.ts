import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/huge server deps are required at runtime from node_modules, never bundled.
  serverExternalPackages: ["playwright", "playwright-core", "pixelmatch", "pngjs"],
};

export default nextConfig;
