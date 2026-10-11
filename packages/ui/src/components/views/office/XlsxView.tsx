import React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { columnName, type XlsxCell, type XlsxSheet, type XlsxWorkbook } from './xlsx';

type XlsxViewProps = {
  workbook: XlsxWorkbook;
};

const isNumericCell = (cell: XlsxCell | null): boolean => cell !== null && (cell.kind === 'number' || cell.kind === 'date');

export function XlsxView({ workbook }: XlsxViewProps) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = React.useState(0);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const idPrefix = React.useId();

  const sheetCount = workbook.sheets.length;
  const safeIndex = Math.min(activeIndex, Math.max(0, sheetCount - 1));
  const sheet = workbook.sheets[safeIndex];

  const cellText = React.useCallback((cell: XlsxCell | null): string => {
    if (!cell) return '';
    if (cell.kind === 'boolean') {
      return cell.value ? t('multichamber.office.booleanTrue') : t('multichamber.office.booleanFalse');
    }
    return cell.text;
  }, [t]);

  // Стрелки/Home/End по паттерну WAI-ARIA tabs: фокус переносится вместе с выбором.
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (safeIndex + 1) % sheetCount;
    else if (event.key === 'ArrowLeft') next = (safeIndex - 1 + sheetCount) % sheetCount;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sheetCount - 1;
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  };

  if (!sheet) {
    return (
      <div className="flex h-full items-center justify-center p-6 typography-ui text-muted-foreground">
        {t('multichamber.office.emptySheet')}
      </div>
    );
  }

  const truncationNote = getTruncationNote(sheet, t);
  const panelId = `${idPrefix}-panel`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-background)]">
      {truncationNote ? (
        <div className="shrink-0 border-b border-border/40 bg-[var(--surface-subtle)] px-3 py-1.5 typography-meta text-muted-foreground">
          {truncationNote}
        </div>
      ) : null}
      <div
        id={panelId}
        role={sheetCount > 1 ? 'tabpanel' : undefined}
        aria-labelledby={sheetCount > 1 ? `${idPrefix}-tab-${safeIndex}` : undefined}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
      >
        {sheet.rows.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 typography-ui text-muted-foreground">
            {t('multichamber.office.emptySheet')}
          </div>
        ) : (
          <SheetTable sheet={sheet} cellText={cellText} />
        )}
      </div>
      {sheetCount > 1 ? (
        <div
          role="tablist"
          aria-label={t('multichamber.office.sheets')}
          className="flex shrink-0 gap-1 overflow-x-auto border-t border-border/40 bg-[var(--surface-subtle)] px-2 py-1.5"
        >
          {workbook.sheets.map((item, index) => {
            const selected = index === safeIndex;
            return (
              <button
                key={`${index}-${item.name}`}
                ref={(node) => { tabRefs.current[index] = node; }}
                id={`${idPrefix}-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveIndex(index)}
                onKeyDown={handleTabKeyDown}
                className={cn(
                  'max-w-[12rem] shrink-0 truncate rounded-md px-3 py-1.5 typography-ui-label transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                  selected
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                    : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
                )}
                title={item.name}
              >
                {item.name}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type SheetTableProps = {
  sheet: XlsxSheet;
  cellText: (cell: XlsxCell | null) => string;
};

const SheetTable = React.memo(function SheetTable({ sheet, cellText }: SheetTableProps) {
  const columns = React.useMemo(
    () => Array.from({ length: sheet.columnCount }, (_, index) => columnName(index)),
    [sheet.columnCount],
  );

  return (
    <table className="border-separate border-spacing-0 typography-meta text-foreground">
      <thead>
        <tr>
          <th
            scope="col"
            className="sticky left-0 top-0 z-20 min-w-[2.75rem] border-b border-r border-border/40 bg-[var(--surface-muted)]"
          />
          {columns.map((name) => (
            <th
              key={name}
              scope="col"
              className="sticky top-0 z-10 min-w-[5.5rem] border-b border-r border-border/40 bg-[var(--surface-muted)] px-2 py-1 text-center font-medium text-muted-foreground"
            >
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            <th
              scope="row"
              className="sticky left-0 z-10 border-b border-r border-border/40 bg-[var(--surface-muted)] px-2 py-1 text-right font-medium tabular-nums text-muted-foreground"
            >
              {rowIndex + 1}
            </th>
            {columns.map((name, columnIndex) => {
              const cell = row[columnIndex] ?? null;
              const text = cellText(cell);
              return (
                <td
                  key={name}
                  title={text.length > 24 ? text : undefined}
                  className={cn(
                    'max-w-[20rem] overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-border/40 px-2 py-1',
                    isNumericCell(cell) && 'text-right tabular-nums',
                    cell?.kind === 'boolean' && 'text-center',
                    cell?.kind === 'error' && 'text-[var(--status-error)]',
                  )}
                >
                  {text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

function getTruncationNote(
  sheet: XlsxSheet,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  if (sheet.truncatedRows && sheet.truncatedColumns) {
    return t('multichamber.office.truncatedBoth', { rows: sheet.rows.length, columns: sheet.columnCount });
  }
  if (sheet.truncatedRows) {
    return t('multichamber.office.truncatedRows', { rows: sheet.rows.length });
  }
  if (sheet.truncatedColumns) {
    return t('multichamber.office.truncatedColumns', { columns: sheet.columnCount });
  }
  return null;
}
