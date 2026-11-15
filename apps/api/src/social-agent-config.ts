/** Server configuration only. Importing this module never loads the model or agent SDK. */
export interface SocialDeepAgentsConfig {
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxModelCalls?: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SocialDeepAgentsConfig {
  return {
    model: (env.DEEPAGENTS_MODEL?.trim() || 'gpt-6-luna').replace(/^openai:/u, ''),
    apiKey: env.DEEPAGENTS_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim(),
  };
}

export function socialDeepAgentsAvailable(config = configFromEnv()): {
  configured: boolean;
  reason: string;
} {
  if (!config.model?.trim())
    return {
      configured: false,
      reason: 'Set DEEPAGENTS_MODEL on the API server to choose the research model.',
    };
  if (!config.apiKey?.trim())
    return {
      configured: false,
      reason:
        'Set OPENAI_API_KEY or DEEPAGENTS_OPENAI_API_KEY on the API server for agent research.',
    };
  if (config.model.includes(':') && !config.model.startsWith('openai:'))
    return {
      configured: false,
      reason:
        'This research adapter supports an OpenAI model. Use its model ID or an openai: model ID.',
    };
  return {
    configured: true,
    reason:
      'The server has an OpenAI model and API key configured. Public search access is configured separately.',
  };
}
