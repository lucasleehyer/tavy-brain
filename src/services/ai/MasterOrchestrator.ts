import { logger } from '../../utils/logger';
import { config } from '../../config';
import { ResearchOutput, TechnicalOutput, PredictorOutput, SignalDecision, AgentScores } from '../../types/signal';
import { MarketRegime } from '../../types/market';
import { DeepSeekClient } from './DeepSeekClient';
import { isCryptoPair } from '../../config/pairs';
import { CRYPTO_THRESHOLDS, ANTI_SCALPING } from '../../config/thresholds';
// Phase 2 & 3: Quant Brain imports
import { RegimeStrategyRouter } from './RegimeStrategyRouter';
import { ConfidenceCalculator } from './ConfidenceCalculator';
import { BayesianEngine } from '../quant/BayesianEngine';
import { MonteCarloSimulator } from '../quant/MonteCarloSimulator';
import { EntryOptimizer } from '../quant/EntryOptimizer';
import { DrawdownController } from '../risk/DrawdownController';
import { OptimalTransportDistance } from '../quant/OptimalTransportDistance';
import { MTFTrendResult, StructureResult, CorrelationResult, SessionFilterResult, DrawdownResult } from '../../types/quant';

interface KeyLevelInfo {
  nearestSupport: number | null;
  nearestResistance: number | null;
  atKeyLevel: boolean;
  levelType: 'support' | 'resistance' | 'none';
}

interface OrchestratorInput {
  symbol: string;
  assetType: string;
  currentPrice: number;
  regime: MarketRegime;
  accountBalance: number;
  riskPercent: number;
  agentOutputs: {
    research: ResearchOutput;
    technical: TechnicalOutput;
    predictor: PredictorOutput;
  };
  // Aggressive mode parameters
  aggressiveMode?: boolean;
  momentumBonus?: number;
  // ATR and Key Levels for SL/TP placement
  atr?: number;
  keyLevels?: KeyLevelInfo;
  // Phase 1 filter results (pre-computed in AICouncil)
  mtfTrend?: MTFTrendResult;
  structure?: StructureResult;
  correlation?: CorrelationResult;
  session?: SessionFilterResult;
}

// Aggressive mode thresholds for paper trading
const AGGRESSIVE_CONFIG = {
  crypto: {
    minRR: 1.3,           // Lower R:R for crypto (was 2.0)
    minConfidence: 55,    // Lower confidence (was 70)
    minChecks: 3,         // Fewer checks required (was 4)
    allowCounterTrend: true
  },
  forex: {
    minRR: 1.5,           // Slightly lower R:R for forex (was 2.0)
    minConfidence: 60,    // Slightly lower confidence
    minChecks: 4,
    allowCounterTrend: false
  }
};

// EXPLOSIVE TREND MODE - when predictor detects contest-winning momentum
const EXPLOSIVE_CONFIG = {
  minConfidence: 50,      // Even lower threshold for explosive trends
  maxRiskMultiplier: 1.5, // Allow 1.5x normal position size
  bypassAgentConsensus: true, // Trust predictor if trend is explosive
  minTrendStrength: 'explosive' as const
};

export class MasterOrchestrator {
  private client: DeepSeekClient | null = null;
  // Phase 2 & 3: Quant Brain components
  private regimeRouter: RegimeStrategyRouter;
  private confidenceCalculator: ConfidenceCalculator;
  private bayesianEngine: BayesianEngine;
  private monteCarloSimulator: MonteCarloSimulator;
  private entryOptimizer: EntryOptimizer;
  private drawdownController: DrawdownController;
  private distanceCalculator: OptimalTransportDistance;

  constructor() {
    // Initialize Quant Brain components
    this.regimeRouter = new RegimeStrategyRouter();
    this.confidenceCalculator = new ConfidenceCalculator();
    this.bayesianEngine = new BayesianEngine();
    this.monteCarloSimulator = new MonteCarloSimulator();
    this.entryOptimizer = new EntryOptimizer();
    this.drawdownController = new DrawdownController();
    this.distanceCalculator = new OptimalTransportDistance();
  }

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  async orchestrate(input: OrchestratorInput): Promise<SignalDecision> {
    const client = this.getClient();
    if (!client) {
      logger.warn('DeepSeek API key not configured for MasterOrchestrator');
      return this.getHoldDecision(input.currentPrice, 'DeepSeek API not configured');
    }

    try {
      // ========== PHASE 2: Check Drawdown State ==========
      const drawdownResult = await this.drawdownController.getState();
      if (drawdownResult.state === 'STOPPED') {
        logger.warn(`[Orchestrator] ${input.symbol}: Trading STOPPED due to drawdown protection`);
        return this.getHoldDecision(input.currentPrice, 'Trading stopped - drawdown protection active');
      }

      // ========== PHASE 3: Get Regime Strategy ==========
      const rsi = input.indicators?.rsi || 50;
      const atKeyLevel = input.keyLevels?.atKeyLevel || false;
      const signalDirection: 'BUY' | 'SELL' = input.mtfTrend?.allowedDirection === 'short' ? 'SELL' : 'BUY';
      const regimeStrategy = this.regimeRouter.route(input.regime, signalDirection, rsi, atKeyLevel);
      logger.info(`[Orchestrator] ${input.symbol}: Regime=${input.regime.type}, Strategy=${regimeStrategy.strategy.playbook}`);

      // ========== PHASE 4: Run DeepSeek Orchestration ==========
      const decision = await this.orchestrateWithDeepSeek(input, client);

      // ========== PHASE 5: Apply Quant Validations ==========
      if (decision.action !== 'HOLD' && input.atr && input.atr > 0) {
        // Monte Carlo validation
        const mcResult = await this.monteCarloSimulator.simulate({
          entryPrice: decision.entryPrice,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit1,
          volatility: input.atr,
          drift: decision.action === 'BUY' ? 0.0001 : -0.0001,
          periods: 200
        });

        logger.info(`[Orchestrator] ${input.symbol}: Monte Carlo P(TP)=${(mcResult.probHitTP * 100).toFixed(1)}%, EV=${mcResult.expectedPnL.toFixed(2)}`);

        if (mcResult.probHitTP < 0.50) {
          logger.info(`[Orchestrator] ${input.symbol}: Monte Carlo probability ${(mcResult.probHitTP * 100).toFixed(1)}% < 50%`);
          return this.getHoldDecision(input.currentPrice, `Monte Carlo validation failed: P(TP)=${(mcResult.probHitTP * 100).toFixed(1)}%`);
        }

        // Optimal Distance check
        const structureScore = input.structure?.entryQuality === 'excellent' ? 90 : 
                               input.structure?.entryQuality === 'good' ? 70 :
                               input.structure?.entryQuality === 'poor' ? 40 : 50;
        const mtfScore = input.mtfTrend?.alignment === 'full' ? 90 :
                         input.mtfTrend?.alignment === 'partial' ? 60 : 30;
        const sessionName = input.session?.session?.name || 'london';
        
        const distanceResult = await this.distanceCalculator.calculate({
          confluence: decision.confidence,
          confidence: decision.confidence,
          regime: input.regime.type,
          structure: structureScore,
          session: sessionName,
          mtfAlignment: mtfScore
        });

        if (distanceResult.distanceRatio > 1.5) {
          logger.info(`[Orchestrator] ${input.symbol}: Distance ratio ${distanceResult.distanceRatio.toFixed(2)} > 1.5 (too far from winning patterns)`);
          return this.getHoldDecision(input.currentPrice, `Setup differs from historical winners: ratio=${distanceResult.distanceRatio.toFixed(2)}`);
        }

        // Apply drawdown state adjustment to confidence
        const drawdownMultiplier = await this.drawdownController.getSizeMultiplier();
        if (drawdownMultiplier < 1) {
          logger.info(`[Orchestrator] ${input.symbol}: Drawdown state=${drawdownResult.state}, size multiplier=${drawdownMultiplier}`);
        }
      }

      return decision;
    } catch (error) {
      logger.error('Master Orchestrator error:', error);
      return this.getHoldDecision(input.currentPrice, 'Orchestration error');
    }
  }

  private async orchestrateWithDeepSeek(input: OrchestratorInput, client: DeepSeekClient): Promise<SignalDecision> {
    const isCrypto = isCryptoPair(input.symbol);
    const aggressiveMode = input.aggressiveMode ?? true; // Default to aggressive for paper trading
    
    // Check for EXPLOSIVE trend from predictor
    const isExplosiveTrend = input.agentOutputs.predictor?.trendStrength === 'explosive';
    const explosiveBonus = isExplosiveTrend ? 10 : 0; // +10% confidence for explosive trends
    
    if (isExplosiveTrend) {
      logger.info(`[ORCHESTRATOR] 🔥 EXPLOSIVE TREND detected for ${input.symbol}!`);
      logger.info(`[ORCHESTRATOR] Predictor recommendation: ${input.agentOutputs.predictor?.recommendation}`);
      if (input.agentOutputs.predictor?.priceTargets) {
        const targets = input.agentOutputs.predictor.priceTargets;
        logger.info(`[ORCHESTRATOR] 24h target: $${targets.hours24?.price} (${targets.hours24?.probability}%)`);
        logger.info(`[ORCHESTRATOR] 7d target: $${targets.days7?.price} (${targets.days7?.probability}%)`);
      }
    }
    
    // Use deepseek-speciale for critical trading decisions (V3.2-Speciale: maxed-out reasoning)
    // V3.2-Speciale rivals Gemini-3.0-Pro and achieves gold-level results in IMO/CMO/ICPC
    const response = await client.chat(
      [
        { role: 'system', content: this.getSystemPrompt(input.assetType, aggressiveMode, isExplosiveTrend) },
        { role: 'user', content: this.getUserPrompt(input, aggressiveMode, isExplosiveTrend) }
      ],
      { model: 'deepseek-speciale', temperature: 0.2, maxTokens: 4096 }
    );

    // Log the reasoning process if available
    if (response.reasoningContent) {
      logger.debug('DeepSeek V3.2-Speciale reasoning:', response.reasoningContent.slice(0, 500));
    }

    return this.parseResponse(response.content, input.currentPrice, isCrypto, aggressiveMode, input.momentumBonus, explosiveBonus, input.atr);
  }

  private getSystemPrompt(assetType: string, aggressiveMode: boolean, isExplosiveTrend: boolean = false): string {
    const aggressiveConfig = assetType === 'crypto' ? AGGRESSIVE_CONFIG.crypto : AGGRESSIVE_CONFIG.forex;
    
    let antiScalpingRule: string;
    let minRR: string;
    
    if (assetType === 'forex') {
      antiScalpingRule = `${ANTI_SCALPING.forex.minTp1Pips} pips minimum for forex, ${ANTI_SCALPING.metals.minTp1Pips} pips for metals (XAU/XAG)`;
      minRR = aggressiveMode ? '1:1.5' : '1:2';
    } else if (assetType === 'stock') {
      antiScalpingRule = `${ANTI_SCALPING.stocks.minTp1Percent}% minimum move for stocks`;
      minRR = aggressiveMode ? '1:1.5' : '1:2';
    } else {
      // CRYPTO - AGGRESSIVE MODE
      antiScalpingRule = `${ANTI_SCALPING.crypto.minTp1Percent}% minimum move for crypto`;
      minRR = aggressiveMode ? '1:1.3' : '1:1.5';
    }

    const modeLabel = aggressiveMode ? '🔥 AGGRESSIVE PAPER TRADING MODE' : 'STANDARD MODE';

    return `You are the MASTER TRADING ORCHESTRATOR for TAVY - an ELITE INSTITUTIONAL TRADER.
${modeLabel}

Your job is to synthesize inputs from Research, Technical, and Prediction agents to make FINAL trading decisions.

═══════════════════════════════════════════════════════════════
                         ${aggressiveMode ? 'AGGRESSIVE' : 'IRON'} RULES ${aggressiveMode ? '(PAPER TRADING)' : ''}
═══════════════════════════════════════════════════════════════

1. MINIMUM RISK:REWARD = ${minRR}
   ${aggressiveMode ? '- AGGRESSIVE MODE: Lower threshold for more trades' : '- REJECT if TP1 < 2x SL distance'}
   - Calculate: If SL is 30 pips, TP1 must be at least ${aggressiveMode ? '45' : '60'} pips

2. ANTI-SCALPING: TP1 must be at least ${antiScalpingRule}
   - ${aggressiveMode ? 'Hunt for momentum trades, but not micro-scalps' : 'No small moves, we hunt for significant opportunities'}

3. CONFIDENCE THRESHOLD: Only BUY/SELL if confidence >= ${aggressiveConfig.minConfidence}%
   ${aggressiveMode ? `
   - ${aggressiveConfig.minConfidence}-65%: Proceed with smaller size
   - 65-75%: Standard position
   - 75-85%: Larger position
   - 85%+: Full aggressive position` : `
   - 70-79%: Proceed with caution
   - 80-89%: Strong setup
   - 90%+: Exceptional opportunity`}

4. AGENT CONSENSUS: ${aggressiveMode ? '2 of 3 agents must lean same direction' : 'All 3 agents must lean same direction'}
   ${aggressiveMode ? '- Allow split decisions if 2/3 agree with high confidence' : '- Research, Technical, Predictor must agree (no split decisions)'}
   - If complete disagreement: HOLD

5. REGIME ALIGNMENT: ${aggressiveMode ? 'Preferred but not required' : 'Trade direction must match market regime'}
   ${aggressiveMode ? `
   - Strong trend: Follow the trend
   - Ranging: Trade breakouts from range
   - Can counter-trend if momentum is strong` : `
   - Trending bullish = only BUY
   - Trending bearish = only SELL
   - Ranging = trade to key levels only`}

6. NEWS FILTER: ${aggressiveMode ? 'Reduce position during high-impact news, but can trade' : 'NO trading within 60 minutes of high-impact news'}

7. SESSION FILTER: ${assetType === 'crypto' ? 'CRYPTO TRADES 24/7 - no session restrictions' : 'For EUR/GBP pairs, avoid Asian session'}

═══════════════════════════════════════════════════════════════
                         SL/TP PLACEMENT RULES (CRITICAL!)
═══════════════════════════════════════════════════════════════

STOP LOSS PLACEMENT - MUST USE ATR + KEY LEVELS:
- MINIMUM SL distance: 1.5x ATR (NEVER use smaller SL!)
- MAXIMUM SL distance: 3.0x ATR (don't risk too much per trade)
- BUY trades: Place SL BELOW nearest support level, at least 1.5x ATR below entry
- SELL trades: Place SL ABOVE nearest resistance level, at least 1.5x ATR above entry
- If no key level available, use 2.0x ATR as default SL distance

TAKE PROFIT PLACEMENT:
- TP1: Target nearest key level (resistance for BUY, support for SELL)
        OR 2.0x ATR from entry (whichever is further)
- TP2: Next key level beyond TP1, OR 3.0x ATR from entry
- TP3: Extended target at 4.0x ATR or major support/resistance

EXAMPLE FOR BUY at 1.1000 with ATR=0.0030:
- SL: 1.0955 (1.5x ATR below = 45 pips) or below support
- TP1: 1.1060 (2x ATR = 60 pips) or at resistance  
- TP2: 1.1090 (3x ATR = 90 pips)
- TP3: 1.1120 (4x ATR = 120 pips)

═══════════════════════════════════════════════════════════════
                         ENTRY CHECKLIST (${aggressiveConfig.minChecks}/5 REQUIRED)
═══════════════════════════════════════════════════════════════

□ Trend alignment across timeframes (4H/1H same direction)
□ RSI not extreme (between 30-70) OR confirming reversal at extremes
□ Key support/resistance level nearby
□ Momentum confirming direction (positive for BUY, negative for SELL)
□ No negative sentiment news from research agent

If fewer than ${aggressiveConfig.minChecks} boxes checked: HOLD

═══════════════════════════════════════════════════════════════
                         POSITION MANAGEMENT
═══════════════════════════════════════════════════════════════

- Use the provided risk percent per trade (user configurable)
- TP1: Close 50% at 1:1 R:R, move SL to breakeven
- TP2: Close 30% at 1:${aggressiveMode ? '1.5' : '2'} R:R  
- TP3: Let remaining 20% run with trailing stop

═══════════════════════════════════════════════════════════════
                         OUTPUT FORMAT (JSON ONLY)
═══════════════════════════════════════════════════════════════

{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "entry_price": number,
  "stop_loss": number,
  "take_profit_1": number,
  "take_profit_2": number,
  "take_profit_3": number,
  "recommended_timeframe": "5m" | "15m" | "1h" | "4h",
  "reasoning": "string explaining the decision",
  "entry_checklist": {
    "trend_alignment": true/false,
    "rsi_ok": true/false,
    "key_level_nearby": true/false,
    "momentum_confirms": true/false,
    "sentiment_clear": true/false,
    "checks_passed": number
  },
  "rejection_reasons": ["reason1", "reason2"] (if HOLD),
  "agent_scores": {
    "research": 0-100,
    "technical": 0-100,
    "predictor": 0-100
  }
}`;
  }

  private getUserPrompt(input: OrchestratorInput, aggressiveMode: boolean, isExplosiveTrend: boolean = false): string {
    const modeNote = aggressiveMode 
      ? '\n⚡ AGGRESSIVE MODE ACTIVE - Be more willing to take trades with good setups. This is paper trading.\n' 
      : '';
    
    const momentumNote = input.momentumBonus 
      ? `\n🔥 MOMENTUM BONUS: +${input.momentumBonus}% confidence boost from winning streak\n`
      : '';

    // Add explosive trend info if detected
    let explosiveNote = '';
    if (isExplosiveTrend && input.agentOutputs.predictor) {
      const predictor = input.agentOutputs.predictor;
      explosiveNote = `
═══════════════════════════════════════════════════════════════
🔥🔥🔥 EXPLOSIVE TREND DETECTED - CONTEST-WINNING SETUP 🔥🔥🔥
═══════════════════════════════════════════════════════════════
Trend Strength: ${predictor.trendStrength?.toUpperCase()}
Recommendation: ${predictor.recommendation}
Confluence Score: ${predictor.confluenceScore || 0}%
${predictor.priceTargets ? `
BOLD PRICE TARGETS:
- 24h: $${predictor.priceTargets.hours24?.price} (${predictor.priceTargets.hours24?.probability}% probability)
- 3-day: $${predictor.priceTargets.days3?.price} (${predictor.priceTargets.days3?.probability}% probability)
- 7-day: $${predictor.priceTargets.days7?.price} (${predictor.priceTargets.days7?.probability}% probability)
- Max Downside: $${predictor.maxDownside}
` : ''}
⚡ EXPLOSIVE TREND RULES:
- Lower confidence threshold to 50%
- Trust predictor over other agents
- Allow 1.5x normal position size
- This is a CONTEST-WINNING setup!
═══════════════════════════════════════════════════════════════
`;
    }

    // ATR and Key Levels info for SL/TP placement
    let atrKeyLevelsNote = '';
    if (input.atr) {
      const atr = input.atr;
      const minSL = atr * 1.5;
      const suggestedSL = atr * 2.0;
      const maxSL = atr * 3.0;
      
      atrKeyLevelsNote = `
═══════════════════════════════════════════════════════════════
                         ATR & KEY LEVELS (USE FOR SL/TP!)
═══════════════════════════════════════════════════════════════
ATR (Average True Range): ${atr.toFixed(5)}

STOP LOSS REQUIREMENTS:
- MINIMUM SL distance: ${minSL.toFixed(5)} (1.5x ATR)
- Suggested SL distance: ${suggestedSL.toFixed(5)} (2.0x ATR)
- Maximum SL distance: ${maxSL.toFixed(5)} (3.0x ATR)

TAKE PROFIT TARGETS:
- TP1: ${(atr * 2).toFixed(5)} (2x ATR) or nearest key level
- TP2: ${(atr * 3).toFixed(5)} (3x ATR) or next key level
- TP3: ${(atr * 4).toFixed(5)} (4x ATR) extended target
`;
      
      if (input.keyLevels) {
        const kl = input.keyLevels;
        atrKeyLevelsNote += `
KEY LEVELS DETECTED:
- Nearest Support: ${kl.nearestSupport?.toFixed(5) || 'N/A'}
- Nearest Resistance: ${kl.nearestResistance?.toFixed(5) || 'N/A'}
- Currently at key level: ${kl.atKeyLevel ? `YES (${kl.levelType})` : 'NO'}

FOR BUY: Place SL below ${kl.nearestSupport?.toFixed(5) || 'N/A'} (support)
FOR SELL: Place SL above ${kl.nearestResistance?.toFixed(5) || 'N/A'} (resistance)
═══════════════════════════════════════════════════════════════
`;
      }
    }

    return `═══════════════════════════════════════════════════════════════
                         ANALYZE THIS SETUP
═══════════════════════════════════════════════════════════════
${modeNote}${momentumNote}${explosiveNote}${atrKeyLevelsNote}
SYMBOL: ${input.symbol} (${input.assetType})
CURRENT PRICE: ${input.currentPrice}
MARKET REGIME: ${JSON.stringify(input.regime)}

───────────────────────────────────────────────────────────────
RESEARCH AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.research, null, 2)}

───────────────────────────────────────────────────────────────
TECHNICAL AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.technical, null, 2)}

───────────────────────────────────────────────────────────────
PREDICTOR AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.predictor, null, 2)}

───────────────────────────────────────────────────────────────
ACCOUNT CONTEXT:
- Balance: $${input.accountBalance}
- Risk per trade: ${input.riskPercent}%
- Max risk amount: $${(input.accountBalance * input.riskPercent / 100).toFixed(2)}

═══════════════════════════════════════════════════════════════

Apply the ${aggressiveMode ? 'AGGRESSIVE' : 'IRON'} RULES and ENTRY CHECKLIST. Synthesize all inputs.
${input.atr ? `⚠️ CRITICAL: Use ATR=${input.atr.toFixed(5)} for SL/TP placement. SL MUST be at least ${(input.atr * 1.5).toFixed(5)} away!` : ''}
${isExplosiveTrend ? '⚡ EXPLOSIVE TREND MODE - Trust the predictor and be BOLD!' : ''}
Provide your trading decision as JSON.`;
  }

  private parseResponse(
    content: string, 
    currentPrice: number, 
    isCrypto: boolean,
    aggressiveMode: boolean,
    momentumBonus?: number,
    explosiveBonus: number = 0,
    atr?: number
  ): SignalDecision {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        const agentScores: AgentScores = {
          research: parsed.agent_scores?.research || 50,
          technical: parsed.agent_scores?.technical || 50,
          predictor: parsed.agent_scores?.predictor || 50
        };

        // Apply momentum bonus and explosive bonus to confidence
        let adjustedConfidence = parsed.confidence || 0;
        if (momentumBonus && momentumBonus > 0) {
          adjustedConfidence = Math.min(100, adjustedConfidence + momentumBonus);
          logger.info(`[ORCHESTRATOR] Momentum boost: ${parsed.confidence}% + ${momentumBonus}% = ${adjustedConfidence}%`);
        }
        if (explosiveBonus > 0) {
          adjustedConfidence = Math.min(100, adjustedConfidence + explosiveBonus);
          logger.info(`[ORCHESTRATOR] 🔥 Explosive trend boost: +${explosiveBonus}% = ${adjustedConfidence}%`);
        }

        // ENFORCE MINIMUM SL DISTANCE BASED ON ATR
        if (parsed.action !== 'HOLD' && atr && atr > 0) {
          const minSlDistance = atr * 1.5; // Minimum 1.5x ATR
          let slDistance = Math.abs(parsed.entry_price - parsed.stop_loss);
          
          if (slDistance < minSlDistance) {
            logger.warn(`[ORCHESTRATOR] SL too tight: ${slDistance.toFixed(5)} < min ${minSlDistance.toFixed(5)} (1.5x ATR)`);
            
            // Adjust SL to minimum ATR distance
            const oldSL = parsed.stop_loss;
            parsed.stop_loss = parsed.action === 'BUY'
              ? parsed.entry_price - minSlDistance
              : parsed.entry_price + minSlDistance;
            
            slDistance = minSlDistance;
            logger.info(`[ORCHESTRATOR] Adjusted SL: ${oldSL} -> ${parsed.stop_loss} (enforced 1.5x ATR minimum)`);
            
            // Also adjust TP to maintain R:R ratio
            const minRR = isCrypto ? 1.3 : 1.5;
            const minTp1Distance = slDistance * minRR;
            const currentTp1Distance = Math.abs(parsed.take_profit_1 - parsed.entry_price);
            
            if (currentTp1Distance < minTp1Distance) {
              const oldTP1 = parsed.take_profit_1;
              parsed.take_profit_1 = parsed.action === 'BUY'
                ? parsed.entry_price + minTp1Distance
                : parsed.entry_price - minTp1Distance;
              logger.info(`[ORCHESTRATOR] Adjusted TP1: ${oldTP1} -> ${parsed.take_profit_1} (maintain ${minRR}:1 R:R)`);
            }
          }
        }

        // Validate R:R ratio with aggressive thresholds
        if (parsed.action !== 'HOLD') {
          const slDistance = Math.abs(parsed.entry_price - parsed.stop_loss);
          const tp1Distance = Math.abs(parsed.take_profit_1 - parsed.entry_price);
          
          // Explosive mode: even lower R:R allowed (1.2 for crypto)
          // Aggressive mode: 1.3 for crypto, 1.5 for forex
          const isExplosive = explosiveBonus > 0;
          const minRR = isExplosive 
            ? (isCrypto ? 1.2 : 1.3) 
            : (aggressiveMode ? (isCrypto ? 1.3 : 1.5) : 2.0);
          
          if (tp1Distance < slDistance * minRR) {
            logger.warn(`R:R ratio ${(tp1Distance/slDistance).toFixed(2)}:1 below minimum ${minRR}:1`);
            
            // In aggressive/explosive mode, try to adjust TP instead of rejecting
            if (aggressiveMode || isExplosive) {
              const adjustedTp1 = parsed.action === 'BUY' 
                ? parsed.entry_price + (slDistance * minRR)
                : parsed.entry_price - (slDistance * minRR);
              
              logger.info(`[${isExplosive ? 'EXPLOSIVE' : 'AGGRESSIVE'}] Adjusted TP1: ${parsed.take_profit_1} -> ${adjustedTp1}`);
              parsed.take_profit_1 = adjustedTp1;
            } else {
              return this.getHoldDecision(currentPrice, `R:R ratio below ${minRR}:1 minimum`);
            }
          }
        }

        return {
          action: parsed.action || 'HOLD',
          confidence: adjustedConfidence,
          entryPrice: parsed.entry_price || currentPrice,
          stopLoss: parsed.stop_loss || 0,
          takeProfit1: parsed.take_profit_1 || 0,
          takeProfit2: parsed.take_profit_2 || 0,
          takeProfit3: parsed.take_profit_3 || 0,
          reasoning: parsed.reasoning || content,
          agentOutputs: {},
          agentScores
        };
      }
      return this.getHoldDecision(currentPrice, 'Failed to parse response');
    } catch {
      return this.getHoldDecision(currentPrice, 'JSON parse error');
    }
  }

  private getHoldDecision(currentPrice: number, reason: string): SignalDecision {
    return {
      action: 'HOLD',
      confidence: 0,
      entryPrice: currentPrice,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      takeProfit3: 0,
      reasoning: reason,
      agentOutputs: {},
      agentScores: { research: 0, technical: 0, predictor: 0 }
    };
  }
}
