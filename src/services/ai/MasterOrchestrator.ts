import { logger } from '../../utils/logger';
import { config } from '../../config';
import { ResearchOutput, TechnicalOutput, PredictorOutput, SignalDecision, AgentScores } from '../../types/signal';
import { MarketRegime } from '../../types/market';
import { DeepSeekClient } from './DeepSeekClient';
import { isCryptoPair } from '../../config/pairs';
import { CRYPTO_THRESHOLDS, ANTI_SCALPING } from '../../config/thresholds';

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
      return await this.orchestrateWithDeepSeek(input, client);
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
    
    // Use deepseek-reasoner for critical trading decisions (thinking mode)
    const response = await client.chat(
      [
        { role: 'system', content: this.getSystemPrompt(input.assetType, aggressiveMode, isExplosiveTrend) },
        { role: 'user', content: this.getUserPrompt(input, aggressiveMode, isExplosiveTrend) }
      ],
      { model: 'deepseek-reasoner', temperature: 0.2, maxTokens: 4096 }
    );

    // Log the reasoning process if available
    if (response.reasoningContent) {
      logger.debug('DeepSeek Reasoner thinking:', response.reasoningContent.slice(0, 500));
    }

    return this.parseResponse(response.content, input.currentPrice, isCrypto, aggressiveMode, input.momentumBonus, explosiveBonus);
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

    return `═══════════════════════════════════════════════════════════════
                         ANALYZE THIS SETUP
═══════════════════════════════════════════════════════════════
${modeNote}${momentumNote}${explosiveNote}
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
${isExplosiveTrend ? '⚡ EXPLOSIVE TREND MODE - Trust the predictor and be BOLD!' : ''}
Provide your trading decision as JSON.`;
  }

  private parseResponse(
    content: string, 
    currentPrice: number, 
    isCrypto: boolean,
    aggressiveMode: boolean,
    momentumBonus?: number,
    explosiveBonus: number = 0
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
