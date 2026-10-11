import { afterAll, describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { Window } from 'happy-dom';

import { parseDocx } from './docx';
import { unzipOfficeArchive } from './ooxml';

const dom = new Window();
// Ставим DOMParser сразу при загрузке модуля: в локальных типах bun:test нет beforeAll.
const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.DOMParser });

afterAll(() => {
  if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
  else Reflect.deleteProperty(globalThis, 'DOMParser');
  void dom.happyDOM.close();
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// styleId «1» и «a5» имитируют русскую сборку Word, где id стилей локализованы.
const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="a5"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
</w:styles>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W}><w:body>
  <w:p><w:pPr><w:pStyle w:val="a3"/></w:pPr><w:r><w:t>Отчёт</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>Раздел</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Подраздел</w:t></w:r></w:p>
  <w:p>
    <w:r><w:t xml:space="preserve">Обычный </w:t></w:r>
    <w:r><w:rPr><w:b/></w:rPr><w:t>жирный</w:t></w:r>
    <w:r><w:rPr><w:b w:val="0"/><w:i/><w:u w:val="single"/></w:rPr><w:t>курсив</w:t></w:r>
    <w:r><w:br/><w:t>новая строка</w:t></w:r>
    <w:hyperlink r:id="rId9"><w:r><w:t xml:space="preserve"> ссылка</w:t></w:r></w:hyperlink>
    <w:r><w:drawing/></w:r>
  </w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Первый</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Вложенный</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t>Из стиля</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>AB</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:sectPr/>
</w:body></w:document>`;

const buildDocx = (): Uint8Array => zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  'word/document.xml': strToU8(documentXml),
  'word/styles.xml': strToU8(stylesXml),
});

const plain = (text: string) => ({ kind: 'text', text, bold: false, italic: false, underline: false });

describe('parseDocx', () => {
  test('reads headings, runs, lists and tables', async () => {
    const { blocks, truncated } = parseDocx(await unzipOfficeArchive(buildDocx()));
    expect(truncated).toBe(false);
    expect(blocks).toEqual([
      { kind: 'heading', level: 0, runs: [plain('Отчёт')] },
      { kind: 'heading', level: 1, runs: [plain('Раздел')] },
      { kind: 'heading', level: 2, runs: [plain('Подраздел')] },
      {
        kind: 'paragraph',
        runs: [
          plain('Обычный '),
          { kind: 'text', text: 'жирный', bold: true, italic: false, underline: false },
          { kind: 'text', text: 'курсив', bold: false, italic: true, underline: true },
          { kind: 'break' },
          plain('новая строка ссылка'),
          { kind: 'image' },
        ],
      },
      { kind: 'listItem', level: 0, runs: [plain('Первый')] },
      { kind: 'listItem', level: 1, runs: [plain('Вложенный')] },
      { kind: 'listItem', level: 0, runs: [plain('Из стиля')] },
      {
        kind: 'table',
        rows: [
          [
            { colSpan: 1, blocks: [{ kind: 'paragraph', runs: [plain('A')] }] },
            { colSpan: 1, blocks: [{ kind: 'paragraph', runs: [plain('B')] }] },
          ],
          [{ colSpan: 2, blocks: [{ kind: 'paragraph', runs: [plain('AB')] }] }],
        ],
      },
    ]);
  });

  test('rejects documents without a body', async () => {
    const archive = await unzipOfficeArchive(zipSync({ 'word/document.xml': strToU8(`<w:document ${W}/>`) }));
    expect(() => parseDocx(archive)).toThrow();
  });

  test('rejects DOCTYPE declarations', async () => {
    const archive = await unzipOfficeArchive(zipSync({
      'word/document.xml': strToU8(`<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document ${W}><w:body/></w:document>`),
    }));
    expect(() => parseDocx(archive)).toThrow();
  });
});
