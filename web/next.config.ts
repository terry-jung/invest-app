import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin workspace root so Next stops trying to pick a parent lockfile.
  outputFileTracingRoot: path.join(__dirname),
  // The investment-analysis skill can take several minutes; raise body limit for streaming.
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
