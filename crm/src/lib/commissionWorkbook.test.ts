import { expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readCommissionWorkbook } from './commissionWorkbook';

function workbook(sheet: string, extra: Record<string, string> = {}) {
  const members = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Carrier" r:id="r1" /></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml" /></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`, ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, strToU8(v)])));
}
it('reads strings, sparse rows, zero-padded identifiers and Excel dates', () => {
  const serial = (Date.UTC(2026, 10, 16) - Date.UTC(1899, 11, 30)) / 86400000;
  const file = workbook(`<row r="1"><c r="A1" t="inlineStr"><is><t>Policy</t></is></c><c r="B1" t="s"><v>0</v></c></row><row r="3"><c r="A3" s="1"><v>123</v></c><c r="B3" s="2"><v>${serial}</v></c></row>`, {
    'xl/sharedStrings.xml': '<sst><si><t>Effective date</t></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="00000" /></numFmts><cellXfs><xf numFmtId="0" /><xf numFmtId="164" /><xf numFmtId="14" /></cellXfs></styleSheet>',
  });
  expect(readCommissionWorkbook(file)[0]).toEqual({ name: 'Carrier', rows: [['Policy', 'Effective date'], ['', ''], ['00123', '2026-11-16']] });
});
it('rejects formulas, duplicate rows, invalid dates and external worksheets', () => {
  expect(() => readCommissionWorkbook(workbook('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>'))).toThrow(/values-only/);
  expect(() => readCommissionWorkbook(workbook('<row r="1" /><row r="1" />'))).toThrow(/duplicate row/);
  expect(() => readCommissionWorkbook(workbook('<row r="1"><c r="A1" s="0"><v>60</v></c></row>', { 'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="14" /></cellXfs></styleSheet>' }))).toThrow(/real dates/);
  expect(() => readCommissionWorkbook(workbook('', { 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="https://example.com/private" TargetMode="External" /></Relationships>' }))).toThrow(/External/);
});
it('rejects oversized expanded workbook content before parsing it', () => {
  expect(() => readCommissionWorkbook(workbook(' '.repeat(5_000_001)))).toThrow(/expanded size/);
});
