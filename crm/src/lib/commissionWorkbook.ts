import { strFromU8, unzipSync } from 'fflate';

const elements = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
function xml(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw new Error('Workbook metadata is incomplete.');
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Workbook entity declarations are not supported.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (elements(doc, 'parsererror').length) throw new Error('Invalid workbook XML.');
  return doc;
}
/** Values-only XLSX import. Does not evaluate formulas, macros, or external links. */
export function readCommissionWorkbook(bytes: Uint8Array): { name: string; rows: string[][] }[] {
  if (bytes.byteLength > 5_000_000) throw new Error('Use an XLSX file under 5 MB.');
  let total = 0, members = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, { filter: file => {
    if (++members > 2000) throw new Error('Workbook contains too many ZIP members.');
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) return false;
    if (names.has(file.name)) throw new Error('Workbook contains duplicate data members.');
    names.add(file.name);
    total += file.originalSize;
    if (file.originalSize > 5_000_000 || total > 12_000_000) throw new Error('Workbook expanded size exceeds the import limit.');
    return true;
  } });
  const workbook = xml(files['xl/workbook.xml']), relationships = xml(files['xl/_rels/workbook.xml.rels']);
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '');
  const shared = files['xl/sharedStrings.xml'] ? elements(xml(files['xl/sharedStrings.xml']), 'si').map(si => elements(si, 't').map(t => t.textContent ?? '').join('')) : [];
  const styles = files['xl/styles.xml'] ? xml(files['xl/styles.xml']) : undefined;
  const formats = new Map(styles ? elements(styles, 'numFmt').map(f => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '']) : []);
  const xfs = styles ? elements(styles, 'cellXfs')[0] : undefined;
  const styleFormats = xfs ? elements(xfs, 'xf').map(xf => Number(xf.getAttribute('numFmtId'))) : [];
  const sheets = elements(workbook, 'sheet');
  if (!sheets.length || sheets.length > 20) throw new Error('Use a workbook with 1–20 worksheets.');
  return sheets.map(sheet => {
    const relationId = sheet.getAttribute('r:id') ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const relation = elements(relationships, 'Relationship').find(r => r.getAttribute('Id') === relationId);
    if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('External or missing worksheets are not supported.');
    const path = new URL(relation.getAttribute('Target') ?? '', 'https://workbook.invalid/xl/');
    if (path.origin !== 'https://workbook.invalid' || !/^\/xl\/worksheets\/[^/]+\.xml$/.test(path.pathname)) throw new Error('Invalid worksheet path.');
    const doc = xml(files[path.pathname.slice(1)]), rows: string[][] = [];
    if (elements(doc, 'f').length) throw new Error('Export a values-only workbook or CSV before importing formulas.');
    for (const row of elements(doc, 'row')) {
      const r = Number(row.getAttribute('r'));
      if (!Number.isInteger(r) || r < 1 || r > 1001) throw new Error('Use a header and up to 1,000 rows.');
      if (rows[r - 1]) throw new Error('Workbook contains duplicate row numbers.');
      const values: string[] = [];
      for (const cell of elements(row, 'c')) {
        const ref = /^(\p{Lu}+)(\d+)$/u.exec(cell.getAttribute('r') ?? '');
        if (!ref || Number(ref[2]) !== r) throw new Error('Invalid worksheet cell reference.');
        const col = [...ref[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
        if (col < 0 || col >= 64) throw new Error('Use at most 64 worksheet columns.');
        if (values[col] !== undefined) throw new Error('Workbook contains duplicate cell references.');
        const type = cell.getAttribute('t'), raw = elements(cell, 'v')[0]?.textContent ?? '';
        let value = raw;
        if (type === 's') { if (!/^\d+$/.test(raw) || shared[Number(raw)] === undefined) throw new Error('Invalid shared workbook value.'); value = shared[Number(raw)]; }
        else if (type === 'inlineStr') value = elements(cell, 't').map(t => t.textContent ?? '').join('');
        else if (type === 'e') throw new Error('Resolve spreadsheet error cells before import.');
        else if (!type || type === 'n') {
          const formatId = styleFormats[Number(cell.getAttribute('s') ?? 0)] ?? 0;
          const format = formats.get(formatId) ?? '';
          if (raw && ((formatId >= 14 && formatId <= 22) || /[yd]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')))) {
            const serial = Number(raw);
            if (!Number.isInteger(serial) || serial < 0 || serial > 2_958_465 || (!date1904 && serial === 60)) throw new Error('Use real dates without times in mapped date columns.');
            const origin = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
            value = new Date(origin + (serial - (!date1904 && serial > 60 ? 1 : 0)) * 86_400_000).toISOString().slice(0, 10);
          } else if (/^0{2,}$/.test(format) && /^\d+$/.test(raw)) value = raw.padStart(format.length, '0');
        }
        if (value.length > 2000) throw new Error('Workbook cell exceeds the import limit.');
        values[col] = value;
      }
      rows[r - 1] = values;
    }
    const width = Math.max(0, ...Array.from(rows, r => r?.length ?? 0));
    return { name: sheet.getAttribute('name') ?? 'Worksheet', rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? '')) };
  });
}
