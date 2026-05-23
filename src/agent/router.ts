import type { AppConfig, AgentPreference } from '../config/schema';
import { getAgentPreference } from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter, AgentRun, AgentRunOptions } from './types';

type ConcreteAgent = 'claude' | 'codex';

export class ConfiguredAgentAdapter implements AgentAdapter {
  private readonly claude = new ClaudeAdapter({ binary: process.env.LARK_CHANNEL_CLAUDE_BINARY });
  private readonly codex = new CodexAdapter({ binary: process.env.LARK_CHANNEL_CODEX_BINARY });
  private autoResolved: AgentAdapter | undefined;

  constructor(private readonly getConfig: () => AppConfig) {}

  get id(): string {
    return this.select().id;
  }

  get displayName(): string {
    return this.select().displayName;
  }

  async isAvailable(): Promise<boolean> {
    const preference = getEffectivePreference(this.getConfig());
    if (preference === 'claude') return this.claude.isAvailable();
    if (preference === 'codex') return this.codex.isAvailable();

    if (await this.codex.isAvailable()) {
      this.autoResolved = this.codex;
      return true;
    }
    if (await this.claude.isAvailable()) {
      this.autoResolved = this.claude;
      return true;
    }
    return false;
  }

  run(opts: AgentRunOptions): AgentRun {
    return this.select().run(opts);
  }

  private select(): AgentAdapter {
    const preference = getEffectivePreference(this.getConfig());
    if (preference === 'claude') return this.claude;
    if (preference === 'codex') return this.codex;
    return this.autoResolved ?? this.codex;
  }
}

function getEffectivePreference(cfg: AppConfig): AgentPreference | ConcreteAgent {
  const fromEnv = process.env.LARK_CHANNEL_AGENT?.trim().toLowerCase();
  if (fromEnv === 'claude' || fromEnv === 'codex' || fromEnv === 'auto') return fromEnv;
  return getAgentPreference(cfg);
}
