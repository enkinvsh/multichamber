import { describe, expect, it, vi } from 'vitest';
import { createZenyEventsClient } from './zeny-events.js';
import { createNotificationTriggerRuntime } from '../notifications/runtime.js';

describe('zeny-events client and notification fanout hook', () => {
  it('returns null when MULTICHAMBER_ZENY_EVENTS_URL is unset or invalid', () => {
    expect(createZenyEventsClient({ env: {} })).toBeNull();
    const warn = vi.fn();
    expect(createZenyEventsClient({ env: { MULTICHAMBER_ZENY_EVENTS_URL: 'ftp://bad' }, warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith('[multichamber] ignoring invalid MULTICHAMBER_ZENY_EVENTS_URL');
  });

  it('sends projects list and session events with truncated message via fanoutPush', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = createZenyEventsClient({
      env: { MULTICHAMBER_ZENY_EVENTS_URL: 'http://10.88.0.1:8317/zeny/events' },
      fetchImpl,
      readSettings: async () => ({
        projects: [{ id: 'proj-1', label: 'Zeny App', path: '/home/dev/projects/zeny-app' }],
      }),
    });

    await client.sendProjects([{ id: 'proj-1', label: 'Zeny App', path: '/home/dev/projects/zeny-app' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      kind: 'projects',
      projects: [{ id: 'proj-1', label: 'Zeny App', path: '/home/dev/projects/zeny-app' }],
    });

    const longReply = 'A'.repeat(2500);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ notifyOnCompletion: true, notificationMode: 'always' }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({
        session_name: 'Fix auth bug',
        project_name: 'Zeny App',
        worktree: '/home/dev/projects/zeny-app',
      }),
      extractLastMessageText: () => longReply,
      fetchLastAssistantMessageText: async () => longReply,
      resolveNotificationTemplate: (tpl) => tpl,
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification: () => false,
      broadcastUiNotification: () => {},
      sendPushToAllUiSessions: async () => {},
      sendApnsToAllUiSessions: async () => {},
      sendZenyNotification: (payload) => client.sendFromNotification(payload),
      isAnyInteractiveClientVisible: () => true,
      buildOpenCodeUrl: (p) => `http://127.0.0.1:4096${p}`,
      getOpenCodeAuthHeaders: () => ({}),
    });

    await runtime.maybeSendPushForTrigger({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-77',
          sessionID: 'ses-42',
          role: 'assistant',
          finish: 'stop',
          mode: 'build',
          modelID: 'claude-4',
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('http://10.88.0.1:8317/zeny/events');
    expect(calls[1].body.kind).toBe('session');
    expect(calls[1].body.eventId).toBe('ready:ses-42:msg-77');
    expect(calls[1].body.type).toBe('ready');
    expect(calls[1].body.sessionId).toBe('ses-42');
    expect(calls[1].body.sessionName).toBe('Fix auth bug');
    expect(calls[1].body.directory).toBe('/home/dev/projects/zeny-app');
    expect(calls[1].body.project).toEqual({
      id: 'proj-1',
      label: 'Zeny App',
      path: '/home/dev/projects/zeny-app',
    });
    expect(calls[1].body.message).toHaveLength(2000);
    expect(calls[1].body.projects).toEqual([
      { id: 'proj-1', label: 'Zeny App', path: '/home/dev/projects/zeny-app' },
    ]);
  });
});
