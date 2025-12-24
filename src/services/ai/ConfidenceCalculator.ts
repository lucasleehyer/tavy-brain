/**
 * Confidence Calculator
 * 
 * Calculates adjusted confidence based on all filters and factors.
 * Key insight: Confidence should reflect probability of success.
 */

import { ConfidenceResult, ConfidenceAdjustment, MTFTrendResult, StructureResult, CorrelationResult, SessionFilterResult, RegimeStrategyResult } from '../../types/quant';
import { MarketRegime } from '../../types/market';
import { logger } from '../../utils/logger';

interface ConfidenceInputs {
  baseConfidence: number;
  mtf?: MTFTrendResult;
  structure?: StructureResult;
  correlation?: CorrelationResult;
  session?: SessionFilterResult;
  regime?: RegimeStrategyResult;
  marketRegime?: MarketRegime;
  agentScores?: {
    research: number;
    technical: number;
    predictor: number;
  };
  consecutiveWins?: number;
  consecutiveLosses?: number;
}

export class ConfidenceCalculator {
  private readonly MIN_CONFIDENCE_THRESHOLD = 65;
  
  // Adjustment values
  private readonly ADJUSTMENTS = {
    // Positive adjustments
    mtfFullAlignment: 15,
    mtfPartialAlignment: 5,
    structureExcellent: 12,
    structureGood: 6,
    sessionOptimal: 5,
    regimeValid: 8,
    highRegimeStrength: 5,
    consecutiveWinsBonus: 3, // per win, max 9
    agentConsensus: 10,
    
    // Negative adjustments
    mtfConflicting: -20,
    structurePoor: -10,
    structureInvalid: -25,
    sessionSuboptimal: -8,
    regimeInvalid: -15,
    correlationRiskMedium: -5,
    correlationRiskHigh: -15,
    consecutiveLossesPenalty: -5, // per loss, max -15
    agentDisagreement: -10
  };

  /**
   * Calculate adjusted confidence
   */
  calculate(inputs: ConfidenceInputs): ConfidenceResult {
    const adjustments: ConfidenceAdjustment[] = [];
    let adjustedConfidence = inputs.baseConfidence;

    // MTF Trend Filter adjustments
    if (inputs.mtf) {
      if (inputs.mtf.alignment === 'full') {
        adjustments.push({
          source: 'MTF Trend',
          adjustment: this.ADJUSTMENTS.mtfFullAlignment,
          reason: 'Full 4H/1H trend alignment'
        });
        adjustedConfidence += this.ADJUSTMENTS.mtfFullAlignment;
      } else if (inputs.mtf.alignment === 'partial') {
        adjustments.push({
          source: 'MTF Trend',
          adjustment: this.ADJUSTMENTS.mtfPartialAlignment,
          reason: 'Partial trend alignment'
        });
        adjustedConfidence += this.ADJUSTMENTS.mtfPartialAlignment;
      } else if (inputs.mtf.alignment === 'conflicting') {
        adjustments.push({
          source: 'MTF Trend',
          adjustment: this.ADJUSTMENTS.mtfConflicting,
          reason: '4H/1H trend conflict'
        });
        adjustedConfidence += this.ADJUSTMENTS.mtfConflicting;
      }
    }

    // Structure adjustments
    if (inputs.structure) {
      if (inputs.structure.entryQuality === 'excellent') {
        adjustments.push({
          source: 'Structure',
          adjustment: this.ADJUSTMENTS.structureExcellent,
          reason: 'Entry at key structure level'
        });
        adjustedConfidence += this.ADJUSTMENTS.structureExcellent;
      } else if (inputs.structure.entryQuality === 'good') {
        adjustments.push({
          source: 'Structure',
          adjustment: this.ADJUSTMENTS.structureGood,
          reason: 'Entry near structure'
        });
        adjustedConfidence += this.ADJUSTMENTS.structureGood;
      } else if (inputs.structure.entryQuality === 'poor') {
        adjustments.push({
          source: 'Structure',
          adjustment: this.ADJUSTMENTS.structurePoor,
          reason: 'Entry far from structure'
        });
        adjustedConfidence += this.ADJUSTMENTS.structurePoor;
      } else if (inputs.structure.entryQuality === 'invalid') {
        adjustments.push({
          source: 'Structure',
          adjustment: this.ADJUSTMENTS.structureInvalid,
          reason: 'No structure nearby'
        });
        adjustedConfidence += this.ADJUSTMENTS.structureInvalid;
      }
    }

    // Correlation adjustments
    if (inputs.correlation) {
      if (inputs.correlation.correlationRisk === 'high') {
        adjustments.push({
          source: 'Correlation',
          adjustment: this.ADJUSTMENTS.correlationRiskHigh,
          reason: 'High correlation/exposure risk'
        });
        adjustedConfidence += this.ADJUSTMENTS.correlationRiskHigh;
      } else if (inputs.correlation.correlationRisk === 'medium') {
        adjustments.push({
          source: 'Correlation',
          adjustment: this.ADJUSTMENTS.correlationRiskMedium,
          reason: 'Moderate correlation risk'
        });
        adjustedConfidence += this.ADJUSTMENTS.correlationRiskMedium;
      }
    }

    // Session adjustments
    if (inputs.session) {
      if (inputs.session.positionSizeMultiplier >= 1.0) {
        adjustments.push({
          source: 'Session',
          adjustment: this.ADJUSTMENTS.sessionOptimal,
          reason: 'Optimal trading session'
        });
        adjustedConfidence += this.ADJUSTMENTS.sessionOptimal;
      } else if (inputs.session.positionSizeMultiplier < 0.7) {
        adjustments.push({
          source: 'Session',
          adjustment: this.ADJUSTMENTS.sessionSuboptimal,
          reason: 'Suboptimal trading session'
        });
        adjustedConfidence += this.ADJUSTMENTS.sessionSuboptimal;
      }
    }

    // Regime strategy adjustments
    if (inputs.regime) {
      if (inputs.regime.isValidSetup) {
        adjustments.push({
          source: 'Regime Strategy',
          adjustment: this.ADJUSTMENTS.regimeValid,
          reason: `Valid ${inputs.regime.strategy.playbook} setup`
        });
        adjustedConfidence += this.ADJUSTMENTS.regimeValid;
      } else {
        adjustments.push({
          source: 'Regime Strategy',
          adjustment: this.ADJUSTMENTS.regimeInvalid,
          reason: 'Setup conflicts with regime'
        });
        adjustedConfidence += this.ADJUSTMENTS.regimeInvalid;
      }
    }

    // Market regime strength bonus
    if (inputs.marketRegime && inputs.marketRegime.strength > 70) {
      adjustments.push({
        source: 'Regime Strength',
        adjustment: this.ADJUSTMENTS.highRegimeStrength,
        reason: `Strong ${inputs.marketRegime.type} regime (${inputs.marketRegime.strength}%)`
      });
      adjustedConfidence += this.ADJUSTMENTS.highRegimeStrength;
    }

    // Agent consensus check
    if (inputs.agentScores) {
      const scores = Object.values(inputs.agentScores);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length;
      const stdDev = Math.sqrt(variance);
      
      if (stdDev < 10) {
        adjustments.push({
          source: 'Agent Consensus',
          adjustment: this.ADJUSTMENTS.agentConsensus,
          reason: 'Strong agent agreement'
        });
        adjustedConfidence += this.ADJUSTMENTS.agentConsensus;
      } else if (stdDev > 25) {
        adjustments.push({
          source: 'Agent Consensus',
          adjustment: this.ADJUSTMENTS.agentDisagreement,
          reason: 'Significant agent disagreement'
        });
        adjustedConfidence += this.ADJUSTMENTS.agentDisagreement;
      }
    }

    // Momentum adjustments (consecutive wins/losses)
    if (inputs.consecutiveWins && inputs.consecutiveWins > 0) {
      const bonus = Math.min(inputs.consecutiveWins * this.ADJUSTMENTS.consecutiveWinsBonus, 9);
      adjustments.push({
        source: 'Momentum',
        adjustment: bonus,
        reason: `${inputs.consecutiveWins} consecutive wins`
      });
      adjustedConfidence += bonus;
    }
    
    if (inputs.consecutiveLosses && inputs.consecutiveLosses > 0) {
      const penalty = Math.max(inputs.consecutiveLosses * this.ADJUSTMENTS.consecutiveLossesPenalty, -15);
      adjustments.push({
        source: 'Momentum',
        adjustment: penalty,
        reason: `${inputs.consecutiveLosses} consecutive losses`
      });
      adjustedConfidence += penalty;
    }

    // Clamp confidence
    adjustedConfidence = Math.max(0, Math.min(100, adjustedConfidence));

    const meetsThreshold = adjustedConfidence >= this.MIN_CONFIDENCE_THRESHOLD;
    
    const reason = meetsThreshold 
      ? `Confidence ${adjustedConfidence.toFixed(0)}% meets threshold`
      : `Confidence ${adjustedConfidence.toFixed(0)}% below ${this.MIN_CONFIDENCE_THRESHOLD}% threshold`;

    const result: ConfidenceResult = {
      baseConfidence: inputs.baseConfidence,
      adjustedConfidence,
      adjustments,
      meetsThreshold,
      threshold: this.MIN_CONFIDENCE_THRESHOLD,
      reason
    };

    logger.info(`[CONF] ${inputs.baseConfidence}% -> ${adjustedConfidence.toFixed(0)}% | ${meetsThreshold ? 'PASS' : 'FAIL'}`);

    return result;
  }

  /**
   * Get threshold
   */
  getThreshold(): number {
    return this.MIN_CONFIDENCE_THRESHOLD;
  }
}
