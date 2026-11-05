import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8767,
  modules: ["client","communications"],
  frontSdk: true,
  publicDir: false,
  strictPort: false,
});
