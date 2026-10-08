/**
 * Command palette entries and native menu actions a locked-down slot does not
 * offer: About, debug tooling, and multi-run (parallel runs multiply load on a
 * 2-CPU slot).
 */
import { isMultichamberLockdown } from './lockdown';

const LOCKED_PALETTE_COMMANDS: ReadonlySet<string> = new Set(['toggle-memory-debug', 'open-multi-run']);
const LOCKED_MENU_ACTIONS: ReadonlySet<string> = new Set(['about', 'toggle-memory-debug']);

export const withoutMultichamberLockedCommands = <T extends { id: string }>(commands: T[], lockdown: boolean): T[] =>
  lockdown ? commands.filter((command) => !LOCKED_PALETTE_COMMANDS.has(command.id)) : commands;

export const isMultichamberLockedMenuAction = (action: string): boolean =>
  LOCKED_MENU_ACTIONS.has(action) && isMultichamberLockdown();
