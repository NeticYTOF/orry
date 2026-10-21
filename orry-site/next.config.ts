import type { NextConfig } from "next";

/* No output: "standalone" in the local build, so `npm start` (next start) works as is. */
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  /* the dev badge sat on top of the Menu button on phones; it is dev-only */
  devIndicators: false,
  /* PLAN 2.4: nothing that may hold ticket text is cached by Next, in memory or on disk */
  cacheMaxMemorySize: 0
};

export default config;
