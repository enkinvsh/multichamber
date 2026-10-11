import React from 'react';

import { useI18n } from '@/lib/i18n';

import type { DocxBlock, DocxDocument, DocxRun, DocxTableCell } from './docx';

type DocxViewProps = {
  document: DocxDocument;
};

type ListItemBlock = Extract<DocxBlock, { kind: 'listItem' }>;
type RenderGroup = { kind: 'list'; items: ListItemBlock[] } | { kind: 'block'; block: DocxBlock };

// Пустые абзацы в docx служат отступами; в превью они дают дыры между блоками.
const hasVisibleContent = (runs: DocxRun[]): boolean =>
  runs.some((run) => run.kind === 'image' || (run.kind === 'text' && run.text.trim().length > 0));

const groupBlocks = (blocks: DocxBlock[]): RenderGroup[] => {
  const groups: RenderGroup[] = [];
  for (const block of blocks) {
    if (block.kind !== 'table' && !hasVisibleContent(block.runs)) continue;
    if (block.kind === 'listItem') {
      const last = groups[groups.length - 1];
      if (last?.kind === 'list') {
        last.items.push(block);
      } else {
        groups.push({ kind: 'list', items: [block] });
      }
      continue;
    }
    groups.push({ kind: 'block', block });
  }
  return groups;
};

function Runs({ runs, imageLabel }: { runs: DocxRun[]; imageLabel: string }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === 'break') return <br key={index} />;
        if (run.kind === 'image') {
          return (
            <span key={index} className="text-muted-foreground italic">
              {imageLabel}
            </span>
          );
        }
        let node: React.ReactNode = run.text;
        if (run.underline) node = <u>{node}</u>;
        if (run.italic) node = <em>{node}</em>;
        if (run.bold) node = <strong>{node}</strong>;
        return <React.Fragment key={index}>{node}</React.Fragment>;
      })}
    </>
  );
}

function Blocks({ blocks, imageLabel }: { blocks: DocxBlock[]; imageLabel: string }) {
  const groups = groupBlocks(blocks);
  return (
    <>
      {groups.map((group, index) => {
        if (group.kind === 'list') {
          return (
            <ul key={index} className="list-disc pl-5">
              {group.items.map((item, itemIndex) => (
                <li key={itemIndex} style={{ marginLeft: `${Math.min(item.level, 8) * 1.25}rem` }}>
                  <Runs runs={item.runs} imageLabel={imageLabel} />
                </li>
              ))}
            </ul>
          );
        }
        const { block } = group;
        switch (block.kind) {
          case 'heading': {
            const content = <Runs runs={block.runs} imageLabel={imageLabel} />;
            if (block.level <= 1) return <h1 key={index}>{content}</h1>;
            if (block.level === 2) return <h2 key={index}>{content}</h2>;
            return <h3 key={index}>{content}</h3>;
          }
          case 'table':
            return <DocxTable key={index} rows={block.rows} imageLabel={imageLabel} />;
          case 'paragraph':
          case 'listItem':
            return (
              <p key={index}>
                <Runs runs={block.runs} imageLabel={imageLabel} />
              </p>
            );
        }
      })}
    </>
  );
}

function DocxTable({ rows, imageLabel }: { rows: DocxTableCell[][]; imageLabel: string }) {
  return (
    // Обёртка с горизонтальным скроллом: широкие таблицы не должны ломать вёрстку на 390px.
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="border-collapse">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                  className="border border-border px-2 py-1 align-top [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                >
                  <Blocks blocks={cell.blocks} imageLabel={imageLabel} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocxView({ document }: DocxViewProps) {
  const { t } = useI18n();
  const imageLabel = t('multichamber.office.image');
  const isEmpty = React.useMemo(() => groupBlocks(document.blocks).length === 0, [document.blocks]);

  return (
    <div className="h-full overflow-auto bg-[var(--surface-background)]">
      {document.truncated ? (
        <div className="border-b border-border/40 bg-[var(--surface-subtle)] px-3 py-1.5 typography-meta text-muted-foreground">
          {t('multichamber.office.truncatedDocument')}
        </div>
      ) : null}
      {isEmpty ? (
        <div className="flex h-full items-center justify-center p-6 typography-ui text-muted-foreground">
          {t('multichamber.office.emptyDocument')}
        </div>
      ) : (
        <article className="markdown-content mx-auto w-full max-w-3xl break-words px-4 py-5 sm:px-6">
          <Blocks blocks={document.blocks} imageLabel={imageLabel} />
        </article>
      )}
    </div>
  );
}
