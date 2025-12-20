import { logger } from '../../utils/logger';
import { config } from '../../config';
import { Candle } from '../../types/market';
import { PredictorOutput } from '../../types/signal';
import { DeepSeekClient } from './DeepSeekClient';

interface MultiTimeframeCandles {
  '5m': Candle[];
  '15m': Candle[];
  '1h': Candle[];
  '4h': Candle[];
}

export class PredictorAgent {
  private client: DeepSeekClient | null = null;

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  async predict(
    symbol: string,
    candles: Candle[] | MultiTimeframeCandles,
    currentPrice: number
  ): Promise<PredictorOutput> {
    const client = this.getClient();
    if (!client) {
      logger.warn('DeepSeek API key not configured for PredictorAgent');
      return this.getDefaultOutput();
    }

    try {
      const candleData = this.formatCandleData(candles);
      
      const prompt = `Analyze multi-timeframe price data for ${symbol} and predict short-term movement:

Current Price: ${currentPrice}

${candleData}

Analyze ALL timeframes for confluence. Look for:
1. Higher timeframe trend direction (4H, 1H)
2. Medium timeframe momentum (15m)
3. Lower timeframe entry precision (5m)

Return JSON with:
- predicted_direction: "up" | "down" | "sideways"
- predicted_move: number (in price units, positive for up, negative for down)
- confidence: 0-100
- timeframe: string (recommended timeframe for entry: "5m", "15m", "1h", "4h")
- support_levels: number[] (2-3 key support levels from all timeframes)
- resistance_levels: number[] (2-3 key resistance levels from all timeframes)
- confluence_score: 0-100 (how aligned are all timeframes)`;

      const response = await client.chat(
        [
          { role: 'system', content: 'You are an expert price prediction model specializing in multi-timeframe analysis. Return JSON only.' },
          { role: 'user', content: prompt }
        ],
        { model: 'deepseek-chat', temperature: 0.3, maxTokens: 1024 }
      );

      return this.parseResponse(response.content, currentPrice);

    } catch (error) {
      logger.error('Predictor Agent error:', error);
      return this.getDefaultOutput();
    }
  }

  private formatCandleData(candles: Candle[] | MultiTimeframeCandles): string {
    if (Array.isArray(candles)) {
      // Legacy single timeframe
      return `Candles (15m, last 30): ${JSON.stringify(candles.slice(-30))}`;
    }
    
    // Multi-timeframe format
    const mtf = candles as MultiTimeframeCandles;
    return `
4H Candles (last 10): ${JSON.stringify((mtf['4h'] || []).slice(-10))}
1H Candles (last 15): ${JSON.stringify((mtf['1h'] || []).slice(-15))}
15m Candles (last 20): ${JSON.stringify((mtf['15m'] || []).slice(-20))}
5m Candles (last 25): ${JSON.stringify((mtf['5m'] || []).slice(-25))}`;
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
          timeframe: parsed.timeframe || '15m',
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
