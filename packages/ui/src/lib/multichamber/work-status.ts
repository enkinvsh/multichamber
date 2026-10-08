/**
 * Work-status sections a locked-down slot never renders (usage and MCP are
 * managed by the container), so the section chooser does not offer them either.
 */
const LOCKED_WORK_STATUS_SECTIONS: ReadonlySet<string> = new Set(['usage', 'mcp']);

export const withoutMultichamberLockedSections = <T extends string>(sections: T[], lockdown: boolean): T[] =>
  lockdown ? sections.filter((section) => !LOCKED_WORK_STATUS_SECTIONS.has(section)) : sections;
