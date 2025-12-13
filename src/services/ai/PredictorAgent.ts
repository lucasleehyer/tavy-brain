import OpenAI from 'openai';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { Candle } from '../../types/market';
import { PredictorOutput } from '../../types/signal';

export class PredictorAgent {
  private openai: OpenAI | null = null;

  constructor() {
    if (config.ai.openai.apiKey) {
      this.openai = new OpenAI({
        apiKey: config.ai.openai.apiKey
      });
    }
  }

  async predict(
    symbol: string,
    candles: Candle[],
    currentPrice: number
  ): Promise<PredictorOutput> {
    if (!this.openai) {
      logger.warn('OpenAI API key not configured for PredictorAgent');
      return this.getDefaultOutput();
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        max_completion_tokens: 1024,
        messages: [{
          role: 'system',
          content: 'You are an expert price prediction model. Analyze price action and predict short-term movement. Return JSON only.'
        }, {
          role: 'user',
          content: `Predict short-term price movement for ${symbol}:
Current Price: ${currentPrice}
Recent Candles (last 30): ${JSON.stringify(candles.slice(-30))}

Return JSON with:
- predicted_direction: "up" | "down" | "sideways"
- predicted_move: number (in price units, positive for up, negative for down)
- confidence: 0-100
- timeframe: string (e.g., "4 hours", "1 day")
- support_levels: number[] (2-3 key support levels)
- resistance_levels: number[] (2-3 key resistance levels)`
        }]
      });

      const content = response.choices[0].message.content || '';
      return this.parseResponse(content, currentPrice);

    } catch (error) {
      logger.error('Predictor Agent error:', error);
      return this.getDefaultOutput();
    }
  }

  private parseResponse(content: string, currentPrice: number): PredictorOutput {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          predictedDirection: parsed.predicted_direction || 'sideways',
          predictedMove: parsed.predicted_move || 0,
          confidence: parsed.confidence || 0,
          timeframe: parsed.timeframe || '4 hours',
          supportLevels: parsed.support_levels || [],
          resistanceLevels: parsed.resistance_levels || []
        };
      }
      return this.getDefaultOutput();
    } catch {
      return this.getDefaultOutput();
    }
  }

  private getDefaultOutput(): PredictorOutput {
    return {
      predictedDirection: 'sideways',
      predictedMove: 0,
      confidence: 0,
      timeframe: 'unknown',
      supportLevels: [],
      resistanceLevels: []
    };
  }
}
