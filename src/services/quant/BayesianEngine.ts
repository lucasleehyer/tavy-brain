/**
 * Bayesian Engine
 * 
 * Calculates credible intervals for win rate using Beta distribution.
 * Key insight: Quantify uncertainty to adjust position sizing.
 */

import { BayesianResult } from '../../types/quant';
import { DeepSeekClient } from '../ai/DeepSeekClient';
import { config } from '../../config';
import { logger } from '../../utils/logger';

interface TradeStats {
  wins: number;
  losses: number;
  totalTrades: number;
}

export class BayesianEngine {
  private client: DeepSeekClient | null = null;

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  /**
   * Calculate Bayesian credible interval for win rate
   */
  async calculate(stats: TradeStats): Promise<BayesianResult> {
    const { wins, losses, totalTrades } = stats;

    // If not enough trades, return default with high uncertainty
    if (totalTrades < 10) {
      return {
        posteriorWinRate: 0.5,
        credibleInterval: { lower: 0.3, upper: 0.7, confidence: 0.9 },
        uncertainty: 0.4,
        kellyAdjustment: 0.5, // Half position size due to uncertainty
        recommendedSizeMultiplier: 0.5,
        sampleSize: totalTrades,
        reason: `Insufficient data (${totalTrades} trades) - using conservative estimates`
      };
    }

    // Use DeepSeek for mathematical calculation if available
    const client = this.getClient();
    if (client) {
      try {
        return await this.calculateWithDeepSeek(client, stats);
      } catch (error) {
        logger.warn('Bayesian calculation via DeepSeek failed, using local calculation');
      }
    }

    // Fallback to local approximation
    return this.calculateLocally(stats);
  }

  /**
   * Calculate using DeepSeek for precise mathematics
   */
  private async calculateWithDeepSeek(client: DeepSeekClient, stats: TradeStats): Promise<BayesianResult> {
    const { wins, losses, totalTrades } = stats;

    const prompt = `You are a quantitative analyst. Calculate Bayesian credible intervals for win rate.

Given:
- Wins: ${wins}
- Losses: ${losses}
- Total trades: ${totalTrades}

Using Beta distribution with uninformative prior Beta(1,1):
1. Posterior distribution: Beta(α = 1 + ${wins}, β = 1 + ${losses})
2. Calculate the 90% credible interval (5th and 95th percentiles)
3. Calculate posterior mean (α / (α + β))
4. Calculate uncertainty = (upper - lower) / mean
5. Calculate Kelly adjustment = max(0.3, 1 - min(0.5, uncertainty))

Return ONLY a JSON object:
{
  "posterior_mean": number,
  "lower_bound": number,
  "upper_bound": number,
  "uncertainty": number,
  "kelly_adjustment": number
}`;

    const response = await client.chat(
      [{ role: 'user', content: prompt }],
      { model: 'deepseek-chat', temperature: 0.1, maxTokens: 500 }
    );

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        const uncertainty = parsed.uncertainty || 0.2;
        const kellyAdjustment = parsed.kelly_adjustment || Math.max(0.3, 1 - Math.min(0.5, uncertainty));

        return {
          posteriorWinRate: parsed.posterior_mean || wins / totalTrades,
          credibleInterval: {
            lower: parsed.lower_bound || 0.4,
            upper: parsed.upper_bound || 0.7,
            confidence: 0.9
          },
          uncertainty,
          kellyAdjustment,
          recommendedSizeMultiplier: kellyAdjustment,
          sampleSize: totalTrades,
          reason: `Beta posterior with ${totalTrades} samples, CI width: ${((parsed.upper_bound - parsed.lower_bound) * 100).toFixed(0)}%`
        };
      }
    } catch (error) {
      logger.error('Failed to parse DeepSeek Bayesian response');
    }

    return this.calculateLocally(stats);
  }

  /**
   * Local approximation using normal approximation to Beta
   */
  private calculateLocally(stats: TradeStats): BayesianResult {
    const { wins, losses, totalTrades } = stats;
    
    // Beta posterior parameters
    const alpha = 1 + wins;
    const beta = 1 + losses;
    
    // Posterior mean
    const posteriorMean = alpha / (alpha + beta);
    
    // Variance of Beta distribution
    const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
    const stdDev = Math.sqrt(variance);
    
    // 90% credible interval (using normal approximation)
    const zScore = 1.645; // 90% CI
    const lower = Math.max(0, posteriorMean - zScore * stdDev);
    const upper = Math.min(1, posteriorMean + zScore * stdDev);
    
    // Uncertainty metric
    const uncertainty = (upper - lower) / posteriorMean;
    
    // Kelly adjustment: reduce position size based on uncertainty
    const kellyAdjustment = Math.max(0.3, 1 - Math.min(0.5, uncertainty));

    const result: BayesianResult = {
      posteriorWinRate: posteriorMean,
      credibleInterval: { lower, upper, confidence: 0.9 },
      uncertainty,
      kellyAdjustment,
      recommendedSizeMultiplier: kellyAdjustment,
      sampleSize: totalTrades,
      reason: `Win rate: ${(posteriorMean * 100).toFixed(1)}% [${(lower * 100).toFixed(0)}%-${(upper * 100).toFixed(0)}%], uncertainty: ${(uncertainty * 100).toFixed(0)}%`
    };

    logger.info(`[BAYESIAN] WinRate=${(posteriorMean * 100).toFixed(1)}% CI=[${(lower * 100).toFixed(0)}%-${(upper * 100).toFixed(0)}%] Adj=${kellyAdjustment.toFixed(2)}`);

    return result;
  }

  /**
   * Quick estimate without DeepSeek
   */
  quickEstimate(wins: number, losses: number): { winRate: number; uncertainty: number } {
    const total = wins + losses;
    if (total === 0) return { winRate: 0.5, uncertainty: 1.0 };
    
    const alpha = 1 + wins;
    const beta = 1 + losses;
    const winRate = alpha / (alpha + beta);
    
    // Wilson score interval for quick uncertainty estimate
    const z = 1.645;
    const denominator = 1 + z * z / total;
    const uncertainty = z * Math.sqrt((winRate * (1 - winRate) + z * z / (4 * total)) / total) / denominator;
    
    return { winRate, uncertainty };
  }
}
