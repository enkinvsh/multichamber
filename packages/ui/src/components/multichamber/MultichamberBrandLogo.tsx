import React from 'react';
import { cn } from '@/lib/utils';

type MultichamberBrandLogoProps = {
  src: string;
  label: string;
  width: number;
  height: number;
  color: string;
  className?: string;
};

/**
 * The brand's `logo.svg` drawn as a CSS mask, so its `currentColor` artwork
 * follows the theme color the stock logo would use (an `<img>` would render it black).
 */
export const MultichamberBrandLogo: React.FC<MultichamberBrandLogoProps> = ({ src, label, width, height, color, className }) => {
  const mask = `url("${src}") center / contain no-repeat`;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('inline-block shrink-0', className)}
      style={{ width, height, backgroundColor: color, WebkitMask: mask, mask }}
    />
  );
};
