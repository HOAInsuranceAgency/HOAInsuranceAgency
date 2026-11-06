import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8787,
  modules: ["client","communications","auth"],
});
