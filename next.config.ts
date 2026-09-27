import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel-friendly defaults.
  // libSQL ships native bindings but the JS-only build works on Vercel
  // serverless. If you hit "module not found" at build time on Vercel,
  // add `serverExternalPackages: ["@libsql/client"]` here.
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
