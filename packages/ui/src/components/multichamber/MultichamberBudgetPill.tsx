import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import {
  type MultichamberBudget,
  type MultichamberBudgetState,
  useMultichamberBudgetResetLabel,
} from '@/lib/multichamber/budget';
import { cn } from '@/lib/utils';

const PILL_TONE = {
  ok: 'border-border/60 text-muted-foreground',
  warn80: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning-text)]',
  warn95: 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error-text)]',
  exhausted: 'border-transparent bg-[var(--status-error)] text-[var(--status-error-foreground)]',
} satisfies Record<MultichamberBudgetState, string>;

type MultichamberBudgetPillProps = {
  budget: MultichamberBudget;
  /** Desktop shows the reset countdown in a tooltip; the mobile drawer prints it next to the pill. */
  withResetTooltip?: boolean;
};

export const MultichamberBudgetPill: React.FC<MultichamberBudgetPillProps> = ({ budget, withResetTooltip = false }) => {
  const { t } = useI18n();
  const resetLabel = useMultichamberBudgetResetLabel(budget);
  const label = budget.percent === null
    ? t('multichamber.budget.label')
    : t('multichamber.budget.pill', { percent: budget.percent });
  const tooltipLabel = withResetTooltip ? resetLabel : null;

  const pill = (
    <span
      tabIndex={tooltipLabel ? 0 : undefined}
      className={cn(
        'app-region-no-drag inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 typography-ui-label font-medium tabular-nums',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        PILL_TONE[budget.state],
      )}
    >
      {label}
      {tooltipLabel ? <span className="sr-only">{`. ${tooltipLabel}`}</span> : null}
    </span>
  );

  if (!tooltipLabel) return pill;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{tooltipLabel}</p>
      </TooltipContent>
    </Tooltip>
  );
};
