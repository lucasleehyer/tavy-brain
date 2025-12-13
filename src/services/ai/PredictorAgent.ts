import { logger } from '../../utils/logger';
import { config } from '../../config';
import { Candle } from '../../types/market';
import { PredictorOutput } from '../../types/signal';

export class PredictorAgent {
  private readonly apiUrl = config.ai.lovable.url;
  private readonly model = 'openai/gpt-5';

  async predict(
    symbol: string,
    candles: Candle[],
    currentPrice: number
  ): Promise<PredictorOutput> {
    if (!config.ai.lovable.apiKey) {
      logger.warn('Lovable AI API key not configured');
      return this.getDefaultOutput();
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai.lovable.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
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
        })
      });

      if (!response.ok) {
        throw new Error(`Lovable AI error: ${response.status}`);
      }

      const data = await response.json();
      return this.parseResponse(data.choices[0].message.content, currentPrice);

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
