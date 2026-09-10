import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const mock = fileURLToPath(new URL("./fixtures.ts", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)), plugins: [react()],
  resolve: { alias: [
    { find: "@frontapp/plugin-sdk", replacement: mock },
    { find: /^\.\.\/lib\/(communications|client)$/, replacement: mock },
    { find: /^\.\/client$/, replacement: mock },
  ] },
  server: { host: "127.0.0.1", port: 8767, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
});
