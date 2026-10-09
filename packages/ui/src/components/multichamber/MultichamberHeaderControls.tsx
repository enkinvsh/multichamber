import React from 'react';
import { getMultichamberAccountLinks } from '@/lib/multichamber/brand';
import { useMultichamberBudget } from '@/lib/multichamber/budget';
import { MultichamberAccountMenu } from './MultichamberAccountMenu';
import { MultichamberBudgetPill } from './MultichamberBudgetPill';

// Same look as the header's own icon buttons (Header.tsx DESKTOP_HEADER_ICON_BUTTON_CLASS).
const HEADER_ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Desktop header: budget pill and account menu of a branded server; nothing on a stock one. */
export const MultichamberHeaderControls: React.FC = () => {
  const accountLinks = getMultichamberAccountLinks();
  const budget = useMultichamberBudget();
  if (!budget && !accountLinks) return null;

  return (
    <div className="mr-1 flex shrink-0 items-center gap-1">
      {budget ? <MultichamberBudgetPill budget={budget} withResetTooltip /> : null}
      {accountLinks ? <MultichamberAccountMenu links={accountLinks} triggerClassName={HEADER_ICON_BUTTON_CLASS} /> : null}
    </div>
  );
};
