import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8791,
  modules: ["client","auth","commissions","communications"],
});
