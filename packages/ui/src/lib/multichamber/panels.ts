/**
 * Context panel surfaces a locked-down slot does not offer: Linear and pull
 * requests need integrations the hosted container does not connect; the
 * browser cannot reach the slot's dev servers (see `./browser`).
 */
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { isMultichamberLockdown } from './lockdown';

const LOCKED_CONTEXT_MODES: ReadonlySet<ContextPanelMode> = new Set<ContextPanelMode>(['linear', 'pr', 'browser']);

/** Drops locked surfaces (rail, chooser, digit shortcuts) when `lockdown` is on. */
export const withoutMultichamberLockedSurfaces = <T extends { mode: ContextPanelMode }>(
  surfaces: T[],
  lockdown: boolean,
): T[] => (lockdown ? surfaces.filter((surface) => !LOCKED_CONTEXT_MODES.has(surface.mode)) : surfaces);

/** Ids of open tabs whose mode is locked; empty when lockdown is off. */
export const multichamberLockedTabIds = (
  tabs: readonly { id: string; mode: ContextPanelMode }[],
  lockdown: boolean,
): string[] => (lockdown ? tabs.filter((tab) => LOCKED_CONTEXT_MODES.has(tab.mode)).map((tab) => tab.id) : []);

/** Store-side gate for programmatic openers (Git view, work-status links). */
export const isMultichamberHiddenContextMode = (mode: ContextPanelMode): boolean =>
  LOCKED_CONTEXT_MODES.has(mode) && isMultichamberLockdown();
