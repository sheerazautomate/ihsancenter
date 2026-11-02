/**
 * Excel export, written by hand.
 *
 * No dependency: `xlsx` and `exceljs` are megabytes and would fight the 10 ms CPU
 * budget on the free plan, and all the shop needs is a file that opens in Excel
 * with real numbers -- not a formula engine.
 *
 * The format is SpreadsheetML 2003 (`.xls`). Excel, LibreOffice, Google Sheets and
 * WPS all open it, it is plain XML so a human can read it when something looks
 * wrong, and it carries column widths, bold headers, a frozen header row and true
 * numeric cells, which CSV cannot. What it cannot do is very large row counts:
 * that is what the CSV download is for.
 *
 * Amounts arrive already converted to rupees. A spreadsheet is read by humans, and
 * paisa would force every reader to divide by 100 in a spare column -- which is
 * exactly the step where somebody eventually gets it wrong by a factor of a hundred.
 */

import { buildZip, type ZipEntry } from './zip';

export type Cell = string | number | null;

export interface SheetSpec {
  /** Worksheet name. Excel caps this at 31 characters. */
  name: string;
  columns: string[];
  /** Column widths in characters, one per column. Defaults to a readable 15. */
  widths?: number[];
  rows: Cell[][];
  /** 0-based column indexes to format as money. */
  moneyColumns?: number[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 and Excel rejects the whole file
    // over one of them. A stray tab pasted into a notes field would do it.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cell(value: Cell, money: boolean, rowNumber: number, colIndex: number): string {
  if (value === null || value === undefined || value === '') return '';

  const style = money ? 'sMoney' : 'sText';
  const ref = `${columnLetter(colIndex)}${rowNumber}`;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // ss:Index is omitted: cells are written in order, so Excel infers it. Keeping
    // it would double the file size for no gain.
    void ref;
    return `<Cell ss:StyleID="sNumber"><Data ss:Type="Number">${value}</Data></Cell>`;
  }

  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(String(value))}</Data></Cell>`;
}

function worksheet(sheet: SheetSpec): string {
  const widths = sheet.widths ?? sheet.columns.map(() => 100);
  const cols = widths.map((w) => `<Column ss:AutoFitWidth="0" ss:Width="${w}"/>`).join('');

  const header = `<Row ss:StyleID="sHead">${sheet.columns
    .map((c) => `<Cell ss:StyleID="sHead"><Data ss:Type="String">${escapeXml(c)}</Data></Cell>`)
    .join('')}</Row>`;

  const body = sheet.rows
    .map((row, i) => {
      const rowNumber = i + 2; // row 1 is the header
      const cells = row
        .map((v, c) => {
          // Money columns hold amounts in rupees; plain numbers stay plain so a
          // quantity of 2 does not print as 2.00 in a column headed "Qty".
          const isMoney = (sheet.moneyColumns ?? []).includes(c) && typeof v === 'number';
          return cell(v, isMoney, rowNumber, c);
        })
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('\n      ');

  return `
  <Worksheet ss:Name="${escapeXml(sheet.name.slice(0, 31))}">
    <Table ss:DefaultColumnWidth="80">
      ${cols}
      ${header}
      ${body}
    </Table>
    <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
      <FreezePanes/>
      <FrozenNoSplit/>
      <SplitHorizontal>1</SplitHorizontal>
      <TopRowBottomPane>1</TopRowBottomPane>
      <ActivePane>2</ActivePane>
    </WorksheetOptions>
  </Worksheet>`;
}

export function buildXls(sheets: SheetSpec[], title: string): string {
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Title>${escapeXml(title)}</Title>
    <Author>Ihsan Center</Author>
  </DocumentProperties>
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Bottom"/>
      <Font ss:FontName="Calibri" ss:Size="11"/>
    </Style>
    <Style ss:ID="sHead">
      <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#1F6F43" ss:Pattern="Solid"/>
      <Alignment ss:Vertical="Center"/>
    </Style>
    <Style ss:ID="sText">
      <Alignment ss:Vertical="Bottom"/>
    </Style>
    <Style ss:ID="sNumber">
      <Alignment ss:Horizontal="Right" ss:Vertical="Bottom"/>
    </Style>
    <Style ss:ID="sMoney">
      <NumberFormat ss:Format="#,##0.00"/>
      <Alignment ss:Horizontal="Right" ss:Vertical="Bottom"/>
    </Style>
  </Styles>${sheets.map(worksheet).join('')}
</Workbook>`;
}

/** CSV with a BOM, so Excel on a Windows PC opens Hindi/Urdu names correctly. */
export function buildCsv(columns: string[], rows: Cell[][]): string {
  const quote = (v: Cell): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [columns.map(quote).join(',')];
  for (const row of rows) lines.push(row.map(quote).join(','));

  // \ufeff: without it Excel reads UTF-8 as ANSI and every non-ASCII name becomes
  // mojibake, which for this shop means customer names it cannot match to anyone.
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Real .xlsx
// ---------------------------------------------------------------------------

/**
 * Build a genuine .xlsx (Office Open XML) workbook.
 *
 * Preferred over the SpreadsheetML above because it is what Excel, Google
 * Sheets, LibreOffice, WPS and every phone spreadsheet app actually open. The
 * SpreadsheetML writer stays as the fallback for anything that asks for `.xls`,
 * and is kept because it is the only option when a ZIP cannot be produced.
 *
 * Strings are written inline (`t="inlineStr"`) rather than through a shared
 * string table: it costs some file size and saves a whole part, and a workbook
 * the shop emails around does not care about a few extra kilobytes.
 */

function xmlEscape(value: string): string {
  return escapeXml(value);
}

/** A1-style reference for a zero-based row/column. */
function ref(rowIndex: number, colIndex: number): string {
  return `${columnLetter(colIndex)}${rowIndex + 1}`;
}

function xlsxCell(value: Cell, money: boolean, rowIndex: number, colIndex: number): string {
  const r = ref(rowIndex, colIndex);

  if (value === null || value === undefined || value === '') {
    // An empty styled cell, so borders/fills stay consistent in a table.
    return `<c r="${r}"${money ? ' s="2"' : ''}/>`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${r}"${money ? ' s="2"' : ' s="1"'}><v>${value}</v></c>`;
  }

  return `<c r="${r}" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function xlsxSheet(sheet: SheetSpec): string {
  const lastCol = columnLetter(Math.max(0, sheet.columns.length - 1));

  const cols = (sheet.widths ?? sheet.columns.map(() => 100))
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w / 7)}" customWidth="1"/>`)
    .join('');

  const headerCells = sheet.columns
    .map((label, i) => `<c r="${ref(0, i)}" t="inlineStr" s="3"><is><t>${xmlEscape(label)}</t></is></c>`)
    .join('');

  const bodyRows = sheet.rows
    .map((row, i) => {
      const rowNumber = i + 1; // header is index 0
      const cells = row
        .map((v, c) => xlsxCell(v, (sheet.moneyColumns ?? []).includes(c) && typeof v === 'number', rowNumber, c))
        .join('');
      return `<row r="${rowNumber + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>${cols}</cols>
  <sheetData>
    <row r="1" s="3" customFormat="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  <autoFilter ref="A1:${lastCol}${sheet.rows.length + 1}"/>
</worksheet>`;
}

/** Excel forbids : \ / ? * [ ] in sheet names, cap 31, and requires uniqueness. */
function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31).trim() || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function buildXlsx(sheets: SheetSpec[], title: string): Uint8Array {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${named
  .map(
    (_, i) =>
      `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join('\n')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${named.map((s, i) => `    <sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
  </sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join('\n')}
  <Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // Style indexes used above: 1 = plain text, 2 = money, 3 = header.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F6F43"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Ihsan Center</dc:creator>
  <cp:lastModifiedBy>Ihsan Center</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Ihsan Center</Application>
</Properties>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'docProps/core.xml', content: core },
    { name: 'docProps/app.xml', content: app },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: styles },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: xlsxSheet(s) })),
  ];

  return buildZip(entries);
}
