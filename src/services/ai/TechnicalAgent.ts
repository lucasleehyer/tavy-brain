import { logger } from '../../utils/logger';
import { config } from '../../config';
import { Candle, Indicators, MarketRegime } from '../../types/market';
import { TechnicalOutput } from '../../types/signal';

export class TechnicalAgent {
  private readonly apiUrl = config.ai.lovable.url;
  private readonly model = 'google/gemini-2.5-flash';

  async analyze(
    candles: Candle[],
    indicators: Indicators,
    regime: MarketRegime
  ): Promise<TechnicalOutput> {
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
            content: 'You are an expert technical analyst. Analyze the provided data and return JSON only.'
          }, {
            role: 'user',
            content: `Analyze this technical data:
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
- reasoning: string (brief explanation)`
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Lovable AI error: ${response.status}`);
      }

      const data = await response.json();
      return this.parseResponse(data.choices[0].message.content);

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
