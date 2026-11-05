import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8784,
  modules: ["client","communications"],
});
