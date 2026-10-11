import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { formatHumanSize, LOW_DISK_SPACE_BYTES, useDiskUsage } from '@/hooks/useFilesPanelActions';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface DiskUsageLineProps {
  path: string | null | undefined;
  className?: string;
}

// Тихая строка «Свободно X из Y»: прячется, если рантайм не умеет отдавать место на диске или запрос упал.
export const DiskUsageLine: React.FC<DiskUsageLineProps> = ({ path, className }) => {
  const { t } = useI18n();
  const usage = useDiskUsage(path);

  if (!usage) {
    return null;
  }

  const isLow = usage.free < LOW_DISK_SPACE_BYTES;
  const label = t('multichamber.files.diskUsage', {
    free: formatHumanSize(usage.free, t),
    total: formatHumanSize(usage.total, t),
  });

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 typography-micro',
        isLow ? 'text-[var(--status-warning)]' : 'text-muted-foreground',
        className,
      )}
      title={isLow ? t('multichamber.files.diskLow') : undefined}
    >
      <Icon name="hard-drive-2" className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </div>
  );
};
