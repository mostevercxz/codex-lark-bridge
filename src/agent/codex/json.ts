import type { AgentEvent } from '../types';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  message?: string;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  if (evt.type === 'thread.started') {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  if (evt.type === 'item.started' && evt.item?.type === 'command_execution') {
    const id = evt.item.id ?? 'command';
    yield {
      type: 'tool_use',
      id,
      name: 'Bash',
      input: { command: evt.item.command ?? '' },
    };
    return;
  }

  if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
    const id = evt.item.id ?? 'command';
    yield {
      type: 'tool_result',
      id,
      output: evt.item.aggregated_output ?? '',
      isError: typeof evt.item.exit_code === 'number' ? evt.item.exit_code !== 0 : false,
    };
    return;
  }

  if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
    if (evt.item.text) yield { type: 'text', delta: evt.item.text };
    return;
  }

  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done' };
    return;
  }

  if (evt.type === 'error') {
    yield { type: 'error', message: evt.message ?? 'codex returned an error' };
  }
}
