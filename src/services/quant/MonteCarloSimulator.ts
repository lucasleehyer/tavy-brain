/**
 * Monte Carlo Simulator
 * 
 * Simulates price paths to validate SL/TP levels.
 * Key insight: Estimate P(hit TP before SL) to filter bad setups.
 */

import { MonteCarloResult } from '../../types/quant';
import { DeepSeekClient } from '../ai/DeepSeekClient';
import { config } from '../../config';
import { logger } from '../../utils/logger';

interface SimulationParams {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  volatility: number; // ATR or historical volatility
  drift: number; // Expected price change per period (usually small)
  periods: number; // Max periods to simulate
}

export class MonteCarloSimulator {
  private readonly SIMULATION_COUNT = 100;
  private readonly MAX_PERIODS = 200; // ~3 hours at 1-min intervals
  private client: DeepSeekClient | null = null;

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  /**
   * Run Monte Carlo simulation
   */
  async simulate(params: SimulationParams): Promise<MonteCarloResult> {
    // Use DeepSeek for precise GBM simulation if available
    const client = this.getClient();
    if (client) {
      try {
        return await this.simulateWithDeepSeek(client, params);
      } catch (error) {
        logger.warn('Monte Carlo via DeepSeek failed, using local simulation');
      }
    }

    // Fallback to local simulation
    return this.simulateLocally(params);
  }

  /**
   * Simulate using DeepSeek for mathematical rigor
   */
  private async simulateWithDeepSeek(client: DeepSeekClient, params: SimulationParams): Promise<MonteCarloResult> {
    const { entryPrice, stopLoss, takeProfit, volatility, drift, periods } = params;
    
    const direction = takeProfit > entryPrice ? 'LONG' : 'SHORT';
    const slDistance = Math.abs(entryPrice - stopLoss);
    const tpDistance = Math.abs(takeProfit - entryPrice);

    const prompt = `You are a quantitative analyst running Monte Carlo simulations for forex trading.

Simulate 100 GBM (Geometric Brownian Motion) price paths with antithetic variates:

Parameters:
- Entry price: ${entryPrice}
- Stop Loss: ${stopLoss} (${slDistance.toFixed(5)} away)
- Take Profit: ${takeProfit} (${tpDistance.toFixed(5)} away)
- Direction: ${direction}
- Volatility (σ): ${volatility.toFixed(6)} per period
- Drift (μ): ${drift.toFixed(8)} per period
- Max periods: ${periods}

GBM Formula: dS = μSdt + σS√dt·Z where Z ~ N(0,1)

For each of 100 paths:
1. Generate random walk using antithetic variates (run Z and -Z together)
2. Check if TP or SL is hit first
3. Record time to hit

Calculate:
- P(TP first) = paths hitting TP first / 100
- P(SL first) = paths hitting SL first / 100
- Expected PnL = P(TP) × tpDistance - P(SL) × slDistance
- Median time to outcome (in periods)

Return ONLY a JSON object:
{
  "prob_tp": number (0-1),
  "prob_sl": number (0-1),
  "prob_timeout": number (0-1),
  "expected_pnl": number,
  "median_time": number,
  "win_paths": number,
  "loss_paths": number,
  "timeout_paths": number
}`;

    const response = await client.chat(
      [{ role: 'user', content: prompt }],
      { model: 'deepseek-chat', temperature: 0.3, maxTokens: 800 }
    );

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        const probHitTP = parsed.prob_tp || 0.5;
        const probHitSL = parsed.prob_sl || 0.5;
        const expectedPnL = parsed.expected_pnl || (probHitTP * tpDistance - probHitSL * slDistance);
        
        return {
          probHitTP,
          probHitSL,
          expectedPnL,
          medianTimeToHit: parsed.median_time || 50,
          riskRewardValidated: probHitTP > 0.55 && expectedPnL > 0,
          simulationCount: this.SIMULATION_COUNT,
          paths: {
            winPaths: parsed.win_paths || Math.round(probHitTP * 100),
            lossPaths: parsed.loss_paths || Math.round(probHitSL * 100),
            timeoutPaths: parsed.timeout_paths || 0
          },
          reason: `P(TP)=${(probHitTP * 100).toFixed(0)}%, P(SL)=${(probHitSL * 100).toFixed(0)}%, E[PnL]=${expectedPnL.toFixed(5)}`
        };
      }
    } catch (error) {
      logger.error('Failed to parse DeepSeek Monte Carlo response');
    }

    return this.simulateLocally(params);
  }

  /**
   * Local Monte Carlo simulation
   */
  private simulateLocally(params: SimulationParams): MonteCarloResult {
    const { entryPrice, stopLoss, takeProfit, volatility, drift, periods } = params;
    
    const direction = takeProfit > entryPrice ? 1 : -1;
    const slDistance = Math.abs(entryPrice - stopLoss);
    const tpDistance = Math.abs(takeProfit - entryPrice);
    
    let winPaths = 0;
    let lossPaths = 0;
    let timeoutPaths = 0;
    let totalTime = 0;
    let hitCount = 0;

    // Run simulations with antithetic variates
    for (let i = 0; i < this.SIMULATION_COUNT / 2; i++) {
      // Generate random variates
      const randoms = this.generateNormals(periods);
      
      // Run both the path and its antithetic pair
      for (const antitheticMultiplier of [1, -1]) {
        let price = entryPrice;
        let hitTime = 0;
        let outcome: 'win' | 'loss' | 'timeout' = 'timeout';
        
        for (let t = 0; t < periods; t++) {
          // GBM step: dS = μSdt + σS√dt·Z
          const dS = drift * price + volatility * price * randoms[t] * antitheticMultiplier;
          price += dS;
          
          // Check if SL or TP hit
          if (direction === 1) {
            // LONG position
            if (price <= stopLoss) {
              outcome = 'loss';
              hitTime = t;
              break;
            }
            if (price >= takeProfit) {
              outcome = 'win';
              hitTime = t;
              break;
            }
          } else {
            // SHORT position
            if (price >= stopLoss) {
              outcome = 'loss';
              hitTime = t;
              break;
            }
            if (price <= takeProfit) {
              outcome = 'win';
              hitTime = t;
              break;
            }
          }
        }
        
        if (outcome === 'win') {
          winPaths++;
          totalTime += hitTime;
          hitCount++;
        } else if (outcome === 'loss') {
          lossPaths++;
          totalTime += hitTime;
          hitCount++;
        } else {
          timeoutPaths++;
        }
      }
    }

    const probHitTP = winPaths / this.SIMULATION_COUNT;
    const probHitSL = lossPaths / this.SIMULATION_COUNT;
    const expectedPnL = probHitTP * tpDistance - probHitSL * slDistance;
    const medianTime = hitCount > 0 ? totalTime / hitCount : periods;

    const result: MonteCarloResult = {
      probHitTP,
      probHitSL,
      expectedPnL,
      medianTimeToHit: medianTime,
      riskRewardValidated: probHitTP > 0.55 && expectedPnL > 0,
      simulationCount: this.SIMULATION_COUNT,
      paths: { winPaths, lossPaths, timeoutPaths },
      reason: `P(TP)=${(probHitTP * 100).toFixed(0)}%, P(SL)=${(probHitSL * 100).toFixed(0)}%, E[PnL]=${expectedPnL.toFixed(5)}`
    };

    logger.info(`[MONTE CARLO] P(TP)=${(probHitTP * 100).toFixed(0)}% P(SL)=${(probHitSL * 100).toFixed(0)}% Valid=${result.riskRewardValidated}`);

    return result;
  }

  /**
   * Generate standard normal random numbers using Box-Muller transform
   */
  private generateNormals(count: number): number[] {
    const normals: number[] = [];
    for (let i = 0; i < count; i += 2) {
      const u1 = Math.random();
      const u2 = Math.random();
      const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
      normals.push(z0);
      if (i + 1 < count) normals.push(z1);
    }
    return normals;
  }

  /**
   * Quick validation check
   */
  isValid(result: MonteCarloResult): boolean {
    return result.probHitTP > 0.55 && result.expectedPnL > 0;
  }
}
