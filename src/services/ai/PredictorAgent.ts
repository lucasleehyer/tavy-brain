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
      const isCrypto = symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('SOL') || 
                       symbol.includes('XRP') || symbol.includes('DOGE') || symbol.includes('ADA');
      
      const prompt = `You are an ELITE price forecaster like the contest-winning DeepSeek that predicted Bitcoin's rise to $12,000-$15,000.

═══════════════════════════════════════════════════════════════
ANALYZE: ${symbol} @ ${currentPrice}
═══════════════════════════════════════════════════════════════

${candleData}

BE BOLD AND SPECIFIC. The contest was won by making PRECISE price targets, not vague predictions.

Analyze ALL timeframes for:
1. Higher timeframe trend direction (4H, 1H) 
2. Medium timeframe momentum (15m)
3. Lower timeframe entry precision (5m)
4. ${isCrypto ? 'CRYPTO MOMENTUM - volatility creates opportunity' : 'Forex session timing'}

═══════════════════════════════════════════════════════════════
RETURN EXACT JSON (no markdown):
═══════════════════════════════════════════════════════════════
{
  "predicted_direction": "up" | "down" | "sideways",
  "predicted_move": number (in price units, e.g., +2500 for BTC going up $2,500),
  "confidence": 0-100,
  "timeframe": "5m" | "15m" | "1h" | "4h",
  "support_levels": [number, number, number],
  "resistance_levels": [number, number, number],
  "confluence_score": 0-100 (how aligned are all timeframes),
  
  "price_targets": {
    "hours_24": { "price": number, "probability": 0-100 },
    "days_3": { "price": number, "probability": 0-100 },
    "days_7": { "price": number, "probability": 0-100 }
  },
  "max_downside": number (worst case price if trade goes wrong),
  "trend_strength": "weak" | "moderate" | "strong" | "explosive",
  "recommendation": "Go all-in" | "Scale in" | "Wait" | "Take profits"
}

BE BOLD. Make SPECIFIC price predictions like "$108,500" not "may go up".`;

      const response = await client.chat(
        [
          { role: 'system', content: 'You are an ELITE price prediction model that won a crypto trading contest by making BOLD, SPECIFIC price targets. Return JSON only. No markdown.' },
          { role: 'user', content: prompt }
        ],
        { model: 'deepseek-chat', temperature: 0.4, maxTokens: 1500 }
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
        
        // Parse bold price targets
        const priceTargets = parsed.price_targets ? {
          hours24: {
            price: parsed.price_targets.hours_24?.price || currentPrice,
            probability: parsed.price_targets.hours_24?.probability || 0
          },
          days3: {
            price: parsed.price_targets.days_3?.price || currentPrice,
            probability: parsed.price_targets.days_3?.probability || 0
          },
          days7: {
            price: parsed.price_targets.days_7?.price || currentPrice,
            probability: parsed.price_targets.days_7?.probability || 0
          }
        } : undefined;

        return {
          predictedDirection: parsed.predicted_direction || 'sideways',
          predictedMove: parsed.predicted_move || 0,
          confidence: parsed.confidence || 0,
          timeframe: parsed.timeframe || '15m',
          supportLevels: parsed.support_levels || [],
          resistanceLevels: parsed.resistance_levels || [],
          // Bold forecast fields
          priceTargets,
          maxDownside: parsed.max_downside,
          trendStrength: parsed.trend_strength || 'moderate',
          recommendation: parsed.recommendation || 'Wait',
          confluenceScore: parsed.confluence_score || 0
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
      resistanceLevels: [],
      trendStrength: 'weak',
      recommendation: 'Wait',
      confluenceScore: 0
    };
  }
}
