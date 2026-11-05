/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// The build token stays in Node; only the public DSN and release enter the SPA.
const uploadSentryMaps = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);
const sentryRelease = process.env.VITE_SENTRY_RELEASE || process.env.SENTRY_RELEASE || process.env.AWS_COMMIT_ID;

export default defineConfig({
  plugins: [react(), ...(uploadSentryMaps ? [sentryVitePlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    telemetry: false,
    release: { name: sentryRelease, inject: false },
    sourcemaps: {
      assets: "./dist/**/*.{js,map}",
      filesToDeleteAfterUpload: "./dist/**/*.map",
    },
  })] : [])],
  define: {
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(sentryRelease || ""),
  },
  build: { sourcemap: uploadSentryMaps ? "hidden" : false },
  test: {
    // jsdom so hooks and components can be rendered without a browser.
    environment: "jsdom",
    // No implicit globals: tests import `describe`/`it`/`expect` from "vitest".
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Tests live beside the code they cover, under src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
