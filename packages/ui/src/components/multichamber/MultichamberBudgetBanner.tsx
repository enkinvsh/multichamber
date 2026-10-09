import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getMultichamberBrand } from '@/lib/multichamber/brand';
import { useMultichamberBudget } from '@/lib/multichamber/budget';
import { cn } from '@/lib/utils';

const DISMISSED_STORAGE_KEY = 'multichamber.budgetBanner.dismissed';

const WARNING_TONE = {
  warn80: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning-text)]',
  warn95: 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error-text)]',
};

const readDismissedBanner = (): string | null => {
  try {
    return window.sessionStorage.getItem(DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
};

const rememberDismissedBanner = (bannerKey: string): void => {
  try {
    window.sessionStorage.setItem(DISMISSED_STORAGE_KEY, bannerKey);
  } catch {
    console.warn('[multichamber] session storage unavailable; the budget banner returns after a reload');
  }
};

// One text line tall, so the icon stays on the first line when the text wraps.
const BannerIcon: React.FC = () => (
  <span aria-hidden="true" className="flex h-[1lh] shrink-0 items-center typography-ui-label">
    <Icon name="error-warning" className="size-4" />
  </span>
);

// Notice text and actions share a row while the whole sentence fits;
// otherwise the actions wrap under the text, indented past the icon.
const NOTICE_TEXT_CLASS = 'flex min-w-0 flex-auto items-start gap-2';
const NOTICE_ACTIONS_CLASS = 'flex shrink-0 flex-wrap items-center gap-2 pl-6';

const ExhaustedPanel: React.FC<{ topup: string | null; plans: string | null }> = ({ topup, plans }) => {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 text-[var(--status-error-text)]"
    >
      <div className={NOTICE_TEXT_CLASS}>
        <BannerIcon />
        <p className="min-w-0 typography-ui-label font-medium">{t('multichamber.budget.exhausted')}</p>
      </div>
      {topup || plans ? (
        <div className={NOTICE_ACTIONS_CLASS}>
          {topup ? (
            <Button asChild size="sm">
              <a href={topup}>{t('multichamber.account.topUp')}</a>
            </Button>
          ) : null}
          {plans ? (
            <Button asChild size="sm" variant="outline">
              <a href={plans}>{t('multichamber.budget.changePlan')}</a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Budget notices under the header. The 80% and 95% warnings can be dismissed
 * for the browser session (per state and week); the exhausted panel stays.
 */
export const MultichamberBudgetBanner: React.FC = () => {
  const { t } = useI18n();
  const budget = useMultichamberBudget();
  const [dismissedBanner, setDismissedBanner] = React.useState(readDismissedBanner);
  if (!budget || budget.state === 'ok') return null;

  const links = getMultichamberBrand()?.links ?? null;
  if (budget.state === 'exhausted') {
    return <ExhaustedPanel topup={links?.topup ?? null} plans={links?.plans ?? null} />;
  }

  const bannerKey = `${budget.state}:${budget.resetsAt ?? ''}`;
  if (dismissedBanner === bannerKey) return null;

  const dismiss = () => {
    rememberDismissedBanner(bannerKey);
    setDismissedBanner(bannerKey);
  };
  const topup = links?.topup ?? null;

  return (
    <div
      role="status"
      className={cn('flex shrink-0 items-start gap-2 border-b px-3 py-1.5', WARNING_TONE[budget.state])}
    >
      <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div className={NOTICE_TEXT_CLASS}>
          <BannerIcon />
          <p className="min-w-0 typography-ui-label">
            {budget.state === 'warn80' ? t('multichamber.budget.warn80') : t('multichamber.budget.warn95')}
          </p>
        </div>
        {topup ? (
          <div className={NOTICE_ACTIONS_CLASS}>
            <Button asChild size="xs">
              <a href={topup}>{t('multichamber.account.topUp')}</a>
            </Button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t('multichamber.budget.dismiss')}
        onClick={dismiss}
        className="-my-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="close" className="size-4" />
      </button>
    </div>
  );
};
