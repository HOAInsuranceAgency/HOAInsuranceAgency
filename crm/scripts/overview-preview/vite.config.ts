import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8786,
  modules: ["client","scopedStorage"],
  replacements: {
    "src/lib/googlePlaces": new URL("./AddressAutocomplete.tsx", import.meta.url),
    "src/components/FilePreview": new URL("./FilePreview.tsx", import.meta.url),
  },
});
