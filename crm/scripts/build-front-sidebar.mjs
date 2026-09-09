import { mkdir, copyFile } from "node:fs/promises";

// A real entry avoids Amplify's 404 fallback, which omits custom headers.
// Vite emits absolute asset paths, so the same shell works in this directory.
const output = new URL("../dist/", import.meta.url);
await mkdir(new URL("front-sidebar/", output), { recursive: true });
await copyFile(new URL("index.html", output), new URL("front-sidebar/index.html", output));
