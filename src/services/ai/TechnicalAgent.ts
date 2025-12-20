import { logger } from '../../utils/logger';
import { config } from '../../config';
import { Candle, Indicators, MarketRegime } from '../../types/market';
import { TechnicalOutput } from '../../types/signal';
import { DeepSeekClient } from './DeepSeekClient';

export class TechnicalAgent {
  private client: DeepSeekClient | null = null;

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  async analyze(
    candles: Candle[],
    indicators: Indicators,
    regime: MarketRegime
  ): Promise<TechnicalOutput> {
    const client = this.getClient();
    if (!client) {
      logger.warn('DeepSeek API key not configured');
      return this.getDefaultOutput();
    }

    try {
      const prompt = `Analyze this technical data:
Candles (last 20): ${JSON.stringify(candles.slice(-20))}
Indicators: ${JSON.stringify(indicators)}
Current Regime: ${JSON.stringify(regime)}

Return JSON with:
- trend_direction: "bullish" | "bearish" | "neutral"
- trend_strength: 0-100
- key_levels: { support: number[], resistance: number[] }
- pattern_detected: string (e.g., "double bottom", "head and shoulders", "none")
- entry_zone: { min: number, max: number }
- confidence: 0-100
- reasoning: string (brief explanation)`;

      const response = await client.chat(
        [
          { role: 'system', content: 'You are an expert technical analyst. Analyze the provided data and return JSON only.' },
          { role: 'user', content: prompt }
        ],
        { model: 'deepseek-chat', temperature: 0.3, maxTokens: 1024 }
      );

      return this.parseResponse(response.content);

    } catch (error) {
      logger.error('Technical Agent error:', error);
      return this.getDefaultOutput();
    }
  }

  private parseResponse(content: string): TechnicalOutput {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          trendDirection: parsed.trend_direction || 'neutral',
          trendStrength: parsed.trend_strength || 50,
          keyLevels: parsed.key_levels || { support: [], resistance: [] },
          patternDetected: parsed.pattern_detected || 'none',
          entryZone: parsed.entry_zone || { min: 0, max: 0 },
          confidence: parsed.confidence || 0,
          reasoning: parsed.reasoning || content
        };
      }
      return this.getDefaultOutput();
    } catch {
      return this.getDefaultOutput();
    }
  }

  private getDefaultOutput(): TechnicalOutput {
    return {
      trendDirection: 'neutral',
      trendStrength: 50,
      keyLevels: { support: [], resistance: [] },
      patternDetected: 'none',
      entryZone: { min: 0, max: 0 },
      confidence: 0,
      reasoning: 'Technical analysis unavailable'
    };
  }
}
