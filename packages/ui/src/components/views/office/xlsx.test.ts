import { afterAll, describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { Window } from 'happy-dom';

import { unzipOfficeArchive } from './ooxml';
import { XLSX_MAX_ROWS, classifyNumberFormat, columnName, formatExcelDate, parseXlsx } from './xlsx';

const dom = new Window();
// Ставим DOMParser сразу при загрузке модуля: в локальных типах bun:test нет beforeAll.
const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.DOMParser });

afterAll(() => {
  if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
  else Reflect.deleteProperty(globalThis, 'DOMParser');
  void dom.happyDOM.close();
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${NS}><sheets>
  <sheet name="Отчёт" sheetId="1" r:id="rId1"/>
  <sheet name="Second" sheetId="2" r:id="rId2"/>
  <sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>
</sheets></workbook>`;

const workbookRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst ${NS} count="2" uniqueCount="2">
  <si><t>Имя &amp; фамилия</t></si>
  <si><r><rPr><b/></rPr><t>Жирный</t></r><r><t xml:space="preserve"> хвост</t></r><rPh><t>skip</t></rPh></si>
</sst>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet ${NS}>
  <numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="14" applyNumberFormat="1"/>
    <xf numFmtId="164" applyNumberFormat="1"/>
    <xf numFmtId="10" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet ${NS}><sheetData>
  <row r="1">
    <c r="A1" t="s"><v>0</v></c>
    <c r="B1" t="inlineStr"><is><t>Инлайн</t></is></c>
    <c r="C1"><v>1234.5</v></c>
    <c r="D1" t="b"><v>1</v></c>
  </row>
  <row r="2">
    <c r="A2" t="s"><v>1</v></c>
    <c r="B2"><f>C1*2</f><v>2469</v></c>
    <c r="C2" t="str"><f>A1&amp;"!"</f><v>Имя!</v></c>
    <c r="D2" t="e"><f>1/0</f><v>#DIV/0!</v></c>
  </row>
  <row r="4">
    <c r="A4" s="1"><v>45292</v></c>
    <c r="B4" s="2"><v>45292.5</v></c>
    <c r="C4" s="3"><v>0.125</v></c>
    <c r="E4"><v>0.30000000000000004</v></c>
  </row>
</sheetData></worksheet>`;

const sheet2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet ${NS}><sheetData><row r="1"><c r="B1"><v>7</v></c></row></sheetData></worksheet>`;

const buildXlsx = (extra: Record<string, string> = {}): Uint8Array => zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  'xl/workbook.xml': strToU8(workbookXml),
  'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
  'xl/sharedStrings.xml': strToU8(sharedStringsXml),
  'xl/styles.xml': strToU8(stylesXml),
  'xl/worksheets/sheet1.xml': strToU8(sheet1Xml),
  'xl/worksheets/sheet2.xml': strToU8(sheet2Xml),
  'xl/worksheets/sheet3.xml': strToU8(sheet2Xml),
  ...Object.fromEntries(Object.entries(extra).map(([path, value]) => [path, strToU8(value)])),
});

describe('parseXlsx', () => {
  test('reads visible sheets in workbook order with typed cells', async () => {
    const workbook = parseXlsx(await unzipOfficeArchive(buildXlsx()));
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Отчёт', 'Second']);

    const [first, second] = workbook.sheets;
    expect(first.columnCount).toBe(5);
    expect(first.rows).toHaveLength(4);
    expect(first.rows[0]).toEqual([
      { kind: 'text', text: 'Имя & фамилия' },
      { kind: 'text', text: 'Инлайн' },
      { kind: 'number', text: '1234.5' },
      { kind: 'boolean', value: true },
      null,
    ]);
    expect(first.rows[1]).toEqual([
      { kind: 'text', text: 'Жирный хвост' },
      { kind: 'number', text: '2469' },
      { kind: 'text', text: 'Имя!' },
      { kind: 'error', text: '#DIV/0!' },
      null,
    ]);
    expect(first.rows[2]).toEqual([null, null, null, null, null]);
    expect(first.rows[3]).toEqual([
      { kind: 'date', text: '01.01.2024' },
      { kind: 'date', text: '01.01.2024 12:00' },
      { kind: 'number', text: '12.5%' },
      null,
      { kind: 'number', text: '0.3' },
    ]);
    expect(first.truncatedRows).toBe(false);

    expect(second.columnCount).toBe(2);
    expect(second.rows).toEqual([[null, { kind: 'number', text: '7' }]]);
  });

  test('caps rows and reports truncation', async () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 5 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`).join('');
    const workbook = parseXlsx(await unzipOfficeArchive(buildXlsx({
      'xl/worksheets/sheet2.xml': `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`,
    })));
    const sheet = workbook.sheets[1];
    expect(sheet.rows).toHaveLength(XLSX_MAX_ROWS);
    expect(sheet.truncatedRows).toBe(true);
    expect(sheet.truncatedColumns).toBe(false);
  });

  test('rejects archives without a workbook', async () => {
    const archive = await unzipOfficeArchive(zipSync({ 'word/document.xml': strToU8('<document/>') }));
    expect(() => parseXlsx(archive)).toThrow();
  });

  test('rejects non-zip bytes', async () => {
    await expect(unzipOfficeArchive(strToU8('not a zip at all'))).rejects.toThrow();
  });
});

describe('number formats', () => {
  test('classifies builtin and custom date formats', () => {
    expect(classifyNumberFormat(14, undefined)).toBe('date');
    expect(classifyNumberFormat(22, undefined)).toBe('datetime');
    expect(classifyNumberFormat(46, undefined)).toBe('time');
    expect(classifyNumberFormat(0, 'General')).toBe('general');
    expect(classifyNumberFormat(164, 'yyyy-mm-dd')).toBe('date');
    expect(classifyNumberFormat(165, '"Дней:" 0')).toBe('general');
    expect(classifyNumberFormat(166, '[Red]#,##0.00')).toBe('general');
    expect(classifyNumberFormat(167, '[$-F400]h:mm:ss AM/PM')).toBe('time');
    expect(classifyNumberFormat(168, '0.0%')).toBe('percent');
  });

  test('formats serial dates in both epochs', () => {
    expect(formatExcelDate(45292, 'date', false)).toBe('01.01.2024');
    expect(formatExcelDate(43831, 'date', true)).toBe('02.01.2024');
    expect(formatExcelDate(0.75, 'time', false)).toBe('18:00');
  });

  test('column names', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
  });
});
