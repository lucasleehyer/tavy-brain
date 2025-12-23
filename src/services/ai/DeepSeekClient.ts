import { logger } from '../../utils/logger';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekResponse {
  content: string;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  reasoningContent?: string;
}

export class DeepSeekClient {
  private readonly apiUrl = 'https://api.deepseek.com/v1/chat/completions';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(
    messages: DeepSeekMessage[],
    options: {
      model?: 'deepseek-chat' | 'deepseek-reasoner' | 'deepseek-speciale';
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<DeepSeekResponse> {
    const {
      model = 'deepseek-chat',
      temperature = 0.3,
      maxTokens = 2048
    } = options;

    // V3.2-Speciale endpoint expired Dec 15, 2025 - fallback to deepseek-reasoner (V3.2 Thinking Mode)
    const isSpeciale = model === 'deepseek-speciale';
    if (isSpeciale) {
      logger.warn('DeepSeek V3.2-Speciale endpoint expired Dec 15, 2025 - using deepseek-reasoner (V3.2 Thinking Mode)');
    }
    const actualModel = isSpeciale ? 'deepseek-reasoner' : model;

    try {
      logger.debug(`Using DeepSeek ${actualModel}${isSpeciale ? ' (fallback from Speciale)' : ''}`);
      
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: actualModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const content = data.choices?.[0]?.message?.content || '';
      const reasoningContent = data.choices?.[0]?.message?.reasoning_content;
      
      const tokensUsed = {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0
      };

      logger.debug(`DeepSeek ${model} used ${tokensUsed.total} tokens`);

      return {
        content,
        tokensUsed,
        reasoningContent
      };
    } catch (error) {
      logger.error('DeepSeek API error:', error);
      throw error;
    }
  }

  // Estimate cost based on DeepSeek V3.2 pricing (updated Dec 2024)
  // deepseek-chat: $0.28/1M input (cache miss), $0.42/1M output
  // deepseek-reasoner: $0.28/1M input, $0.42/1M output (same as chat for V3.2)
  // deepseek-speciale: Same pricing as V3.2
  estimateCost(tokensUsed: { prompt: number; completion: number }, model: 'deepseek-chat' | 'deepseek-reasoner' | 'deepseek-speciale'): number {
    // V3.2 unified pricing: $0.28/1M input, $0.42/1M output
    const pricing = { input: 0.28 / 1_000_000, output: 0.42 / 1_000_000 };
    
    return (tokensUsed.prompt * pricing.input) + (tokensUsed.completion * pricing.output);
  }
}
