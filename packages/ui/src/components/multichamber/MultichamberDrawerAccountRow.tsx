import React from 'react';
import { getMultichamberAccountLinks } from '@/lib/multichamber/brand';
import {
  type MultichamberBudget,
  useMultichamberBudget,
  useMultichamberBudgetResetLabel,
} from '@/lib/multichamber/budget';
import { MultichamberAccountMenu } from './MultichamberAccountMenu';
import { MultichamberBudgetPill } from './MultichamberBudgetPill';

// Same look as the drawer's close button (MobileWorkspaceDrawer.tsx).
const DRAWER_ICON_BUTTON_CLASS =
  'flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const BudgetResetText: React.FC<{ budget: MultichamberBudget }> = ({ budget }) => {
  const resetLabel = useMultichamberBudgetResetLabel(budget);
  if (!resetLabel) return null;
  return <span className="min-w-0 truncate typography-meta text-muted-foreground">{resetLabel}</span>;
};

/** Mobile workspace drawer: the header's budget pill and account menu, with the reset countdown spelled out. */
export const MultichamberDrawerAccountRow: React.FC = () => {
  const accountLinks = getMultichamberAccountLinks();
  const budget = useMultichamberBudget();
  if (!budget && !accountLinks) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
      {budget ? (
        <>
          <MultichamberBudgetPill budget={budget} />
          <BudgetResetText budget={budget} />
        </>
      ) : null}
      {accountLinks ? (
        <div className="ml-auto">
          <MultichamberAccountMenu links={accountLinks} triggerClassName={DRAWER_ICON_BUTTON_CLASS} />
        </div>
      ) : null}
    </div>
  );
};
