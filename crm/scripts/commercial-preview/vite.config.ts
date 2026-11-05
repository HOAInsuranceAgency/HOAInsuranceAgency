import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8768,
  modules: ["client","communications"],
  publicDir: false,
  strictPort: false,
});
