import { createPreviewConfig } from '../preview-support/config';
export default createPreviewConfig(import.meta.url, {
  port: 8791,
  replacements: {'src/lib/commissionSession': new URL('./fixtures.ts', import.meta.url), 'src/lib/commissionStatementAttachment': new URL('./fixtures.ts', import.meta.url)},
  modules: ["client","auth","commissions","communications"],
});
