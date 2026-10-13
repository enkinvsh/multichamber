import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Страница «Свой Claude» в кабинете zeny. Эта страница настроек видна только при
 * MULTICHAMBER_OWN_CLAUDE=1, а его включает лишь zeny, поэтому адрес задан здесь, а не
 * ссылкой бренда: среди MULTICHAMBER_*_URL страницы Claude нет, а путь, выведенный из
 * MULTICHAMBER_ACCOUNT_URL, угадывал бы маршруты витрины. Подсказка про код называет
 * zenyweb.com, и ссылка обязана вести ровно туда.
 */
const CLAUDE_CABINET_URL = 'https://zenyweb.com/cabinet/claude';

type NoticeTone = 'info' | 'success' | 'warning';

const NOTICE_TONE_CLASS = {
  info: 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info-text)]',
  success: 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success-text)]',
  warning: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning-text)]',
} as const satisfies Record<NoticeTone, string>;

interface NoticeProps {
  tone: NoticeTone;
  icon: IconName;
  /** Итог нажатия кнопки: живая область, читалка экрана озвучит его сама. */
  live?: boolean;
  children: React.ReactNode;
}

const Notice: React.FC<NoticeProps> = ({ tone, icon, live = false, children }) => (
  <div
    role={live ? 'status' : undefined}
    className={cn('flex items-start gap-2 rounded-md border px-3 py-2 typography-meta', NOTICE_TONE_CLASS[tone])}
  >
    <Icon name={icon} className="mt-0.5 size-4 shrink-0" />
    <div className="min-w-0 space-y-2">{children}</div>
  </div>
);

type ApplyState = 'idle' | 'applying' | 'applied' | 'failed';

/**
 * Лаунчер opencode читает ключ и режим Claude только при старте, поэтому выбор из кабинета
 * доходит до агентов лишь после перезапуска OpenCode, как после правки провайдеров.
 * Стор подгружается лениво, как в deferredRestart.ts: страница не тянет его граф заранее.
 */
const reloadOpenCodeProviders = async (message: string): Promise<void> => {
  const { reloadOpenCodeConfiguration } = await import('@/stores/useAgentsStore');
  await reloadOpenCodeConfiguration({ message, scopes: ['providers'], mode: 'active' });
};

interface MultichamberClaudePageProps {
  /** Перезапуск OpenCode с новыми провайдерами; тесты и стенд подставляют свой. */
  restartOpenCode?: (message: string) => Promise<void>;
}

/**
 * Вход в Claude, выбор режима и отключение живут в кабинете zeny, а не здесь: эту страницу
 * отдаёт контейнер пользователя, и агент с sudo может подменить её и выманить код OAuth.
 * Поэтому страница не ходит в /_zeny/claude/*, а только ведёт в кабинет. Когда там сменили
 * режим, она не знает, поэтому перезапуск запускает сам пользователь кнопкой «Применить».
 */
export const MultichamberClaudePage: React.FC<MultichamberClaudePageProps> = ({
  restartOpenCode = reloadOpenCodeProviders,
}) => {
  const { t } = useI18n();
  const [applyState, setApplyState] = React.useState<ApplyState>('idle');
  const applying = applyState === 'applying';

  const apply = async () => {
    setApplyState('applying');
    try {
      await restartOpenCode(t('multichamber.claude.restarting'));
      setApplyState('applied');
    } catch {
      setApplyState('failed');
    }
  };

  return (
    <SettingsPageLayout
      title={t('multichamber.claude.page.title')}
      description={t('multichamber.claude.page.description')}
    >
      <SettingsSection
        divider={false}
        title={t('multichamber.claude.section.account')}
        settingsItem="claude.account"
        contentClassName="space-y-4"
      >
        <Button asChild size="sm">
          <a href={CLAUDE_CABINET_URL} target="_blank" rel="noopener noreferrer">
            <Icon name="external-link" className="size-4" />
            {t('multichamber.claude.cabinet.open')}
          </a>
        </Button>
        <Notice tone="info" icon="shield-keyhole">
          <p>{t('multichamber.claude.cabinet.codeWarning')}</p>
        </Notice>
      </SettingsSection>

      <SettingsSection
        title={t('multichamber.claude.section.apply')}
        description={t('multichamber.claude.apply.description')}
        contentClassName="space-y-4"
      >
        {applyState === 'failed' ? (
          <Notice tone="warning" icon="error-warning" live>
            <p>{t('multichamber.claude.restartFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void apply()}>
              {t('multichamber.claude.restartOpenCode')}
            </Button>
          </Notice>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={applying}
            aria-busy={applying}
            onClick={() => void apply()}
          >
            {applying ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
            {t('multichamber.claude.apply.button')}
          </Button>
        )}
        {applyState === 'applied' ? (
          <Notice tone="success" icon="checkbox-circle" live>
            <p>{t('multichamber.claude.apply.done')}</p>
          </Notice>
        ) : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
