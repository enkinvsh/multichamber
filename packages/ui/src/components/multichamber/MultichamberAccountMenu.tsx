import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { MultichamberBrandLinks } from '@/lib/multichamber/brand';

type AccountLink = {
  link: keyof MultichamberBrandLinks;
  icon: IconName;
  label: I18nKey;
  newTab: boolean;
};

const ACCOUNT_LINKS: ReadonlyArray<AccountLink> = [
  { link: 'account', icon: 'user', label: 'multichamber.account.home', newTab: false },
  { link: 'plans', icon: 'stack', label: 'multichamber.account.plans', newTab: false },
  { link: 'topup', icon: 'add-circle', label: 'multichamber.account.topUp', newTab: false },
  { link: 'support', icon: 'question', label: 'multichamber.account.support', newTab: true },
];

type MultichamberAccountMenuProps = {
  links: MultichamberBrandLinks;
  triggerClassName: string;
};

export const MultichamberAccountMenu: React.FC<MultichamberAccountMenuProps> = ({ links, triggerClassName }) => {
  const { t } = useI18n();
  const menuLabel = t('multichamber.account.menu');
  const items = ACCOUNT_LINKS.flatMap((item) => {
    const href = links[item.link];
    return href ? [{ ...item, href }] : [];
  });

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={menuLabel} className={triggerClassName}>
              <Icon name="user-3" className="size-[18px]" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{menuLabel}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-44">
        {items.map((item) => (
          <DropdownMenuItem key={item.link} asChild>
            <a
              href={item.href}
              target={item.newTab ? '_blank' : undefined}
              rel={item.newTab ? 'noopener noreferrer' : undefined}
            >
              <Icon name={item.icon} className="mr-1 size-4" />
              <span className="flex-1">{t(item.label)}</span>
              {item.newTab ? <Icon name="external-link" className="size-3.5" /> : null}
            </a>
          </DropdownMenuItem>
        ))}
        {items.length > 0 && links.logout ? <DropdownMenuSeparator /> : null}
        {links.logout ? (
          <DropdownMenuItem asChild>
            <a href={links.logout}>
              <Icon name="logout-box-r" className="mr-1 size-4" />
              <span className="flex-1">{t('multichamber.account.logout')}</span>
            </a>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
