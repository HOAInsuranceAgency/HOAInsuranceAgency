import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

const bytes = new Map<string, Uint8Array>();
function fontBytes(name: string) {
  if (!bytes.has(name)) bytes.set(name, readFileSync(join(process.env.COMMISSION_REPORT_FONT_DIRECTORY ?? fileURLToPath(new URL('./report-fonts/', import.meta.url)), name)));
  return bytes.get(name)!;
}
/** Fonts ship in the Lambda layer and are subset into each PDF. No runtime network. */
export async function reportFonts(doc: PDFDocument) {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fontBytes('NotoSans-Regular.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('NotoSans-Bold.ttf'), { subset: true });
  const cjk = await doc.embedFont(fontBytes('NotoSansCJKsc-Regular.ttf'), { subset: true });
  const supported = new Map([regular, bold, cjk].map(font => [font, new Set(font.getCharacterSet())]));
  function runs(text: string, strong: boolean) {
    const primary = strong ? bold : regular;
    const result: {text: string; font: PDFFont}[] = [];
    for (const char of text) {
      const code = char.codePointAt(0)!;
      const font = supported.get(primary)!.has(code) ? primary : supported.get(cjk)!.has(code) ? cjk : undefined;
      if (!font) throw new Error(`Report font coverage needs extension for U+${code.toString(16).toUpperCase()}. Keep the original source name unchanged.`);
      const last = result.at(-1);
      if (last?.font === font) last.text += char;
      else result.push({text: char, font});
    }
    return result;
  }
  return {regular, bold, runs, width: (text: string, size: number, strong: boolean) => runs(text, strong).reduce((n, r) => n + r.font.widthOfTextAtSize(r.text, size), 0)};
}
