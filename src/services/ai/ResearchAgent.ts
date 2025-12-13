import { logger } from '../../utils/logger';
import { config } from '../../config';
import { ResearchOutput } from '../../types/signal';

export class ResearchAgent {
  private readonly apiUrl = 'https://api.perplexity.ai/chat/completions';
  private readonly model = 'sonar-pro';

  async analyze(symbol: string, assetType: string): Promise<ResearchOutput> {
    if (!config.ai.perplexity.apiKey) {
      logger.warn('Perplexity API key not configured');
      return this.getDefaultOutput();
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai.perplexity.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: `Analyze ${symbol} for ${assetType} trading. Provide:
1. Latest news and sentiment (last 24 hours)
2. Key upcoming events/catalysts
3. Market sentiment score (-100 to +100, where -100 is extremely bearish, +100 is extremely bullish)
4. Sentiment reliability score (0-100, based on number and quality of sources)
5. Brief summary (2-3 sentences)

Return as JSON with fields: sentiment_score, reliability, news_summary, upcoming_events, recommendation`
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Perplexity API error: ${response.status}`);
      }

      const data = await response.json();
      return this.parseResponse(data.choices[0].message.content);

    } catch (error) {
      logger.error('Research Agent error:', error);
      return this.getDefaultOutput();
    }
  }

  private parseResponse(content: string): ResearchOutput {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          sentimentScore: parsed.sentiment_score || 0,
          reliability: parsed.reliability || 50,
          newsSummary: parsed.news_summary || content,
          upcomingEvents: parsed.upcoming_events || [],
          recommendation: parsed.recommendation || 'neutral'
        };
      }
      return {
        sentimentScore: 0,
        reliability: 50,
        newsSummary: content,
        upcomingEvents: [],
        recommendation: 'neutral'
      };
    } catch {
      return this.getDefaultOutput();
    }
  }

  private getDefaultOutput(): ResearchOutput {
    return {
      sentimentScore: 0,
      reliability: 0,
      newsSummary: 'Unable to fetch market research',
      upcomingEvents: [],
      recommendation: 'neutral'
    };
  }
}
