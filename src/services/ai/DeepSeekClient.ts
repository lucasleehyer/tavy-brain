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
      model?: 'deepseek-chat' | 'deepseek-reasoner';
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<DeepSeekResponse> {
    const {
      model = 'deepseek-chat',
      temperature = 0.3,
      maxTokens = 2048
    } = options;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model,
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

  // Estimate cost based on DeepSeek V3.2 pricing
  // deepseek-chat: $0.28/1M input, $1.10/1M output (cache miss)
  // deepseek-reasoner: $0.55/1M input, $2.19/1M output
  estimateCost(tokensUsed: { prompt: number; completion: number }, model: 'deepseek-chat' | 'deepseek-reasoner'): number {
    const pricing = model === 'deepseek-chat' 
      ? { input: 0.28 / 1_000_000, output: 1.10 / 1_000_000 }
      : { input: 0.55 / 1_000_000, output: 2.19 / 1_000_000 };
    
    return (tokensUsed.prompt * pricing.input) + (tokensUsed.completion * pricing.output);
  }
}
