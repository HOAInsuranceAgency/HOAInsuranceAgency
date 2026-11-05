import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8785,
  modules: ["client","scopedStorage","storage","acord"],
  replacements: {
    "src/components/FilePreview": new URL("./FilePreview.tsx", import.meta.url),
  },
});
