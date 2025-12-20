import { logger } from '../../utils/logger';
import { config } from '../../config';
import { ResearchOutput, TechnicalOutput, PredictorOutput, SignalDecision, AgentScores } from '../../types/signal';
import { MarketRegime } from '../../types/market';

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
}

export class MasterOrchestrator {
  private readonly apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

  async orchestrate(input: OrchestratorInput): Promise<SignalDecision> {
    if (!config.ai.google.apiKey) {
      logger.warn('Google API key not configured for MasterOrchestrator');
      return this.getHoldDecision(input.currentPrice, 'Google API not configured');
    }

    try {
      return await this.orchestrateWithGemini(input);
    } catch (error) {
      logger.error('Master Orchestrator error:', error);
      return this.getHoldDecision(input.currentPrice, 'Orchestration error');
    }
  }

  private async orchestrateWithGemini(input: OrchestratorInput): Promise<SignalDecision> {
    const response = await fetch(`${this.apiUrl}?key=${config.ai.google.apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${this.getSystemPrompt(input.assetType)}\n\n${this.getUserPrompt(input)}`
          }]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return this.parseResponse(content, input.currentPrice);
  }

  private getSystemPrompt(assetType: string): string {
    let antiScalpingRule: string;
    if (assetType === 'forex') {
      antiScalpingRule = '40 pips minimum for forex, 80 pips for metals (XAU/XAG)';
    } else if (assetType === 'stock') {
      antiScalpingRule = '0.8% minimum move for stocks';
    } else {
      antiScalpingRule = '1.5% minimum move for crypto';
    }

    return `You are the MASTER TRADING ORCHESTRATOR for TAVY - an ELITE INSTITUTIONAL FOREX TRADER with 20+ years of experience managing $100M+ portfolios.

Your job is to synthesize inputs from Research, Technical, and Prediction agents to make FINAL trading decisions.

═══════════════════════════════════════════════════════════════
                         IRON RULES (NEVER BREAK)
═══════════════════════════════════════════════════════════════

1. MINIMUM RISK:REWARD = 1:2
   - REJECT if TP1 < 2x SL distance
   - Calculate: If SL is 30 pips, TP1 must be at least 60 pips

2. ANTI-SCALPING: TP1 must be at least ${antiScalpingRule}
   - No small moves, we hunt for significant opportunities

3. CONFIDENCE THRESHOLD: Only BUY/SELL if confidence >= 70%
   - 70-79%: Proceed with caution
   - 80-89%: Strong setup
   - 90%+: Exceptional opportunity

4. AGENT CONSENSUS: All 3 agents must lean same direction
   - Research, Technical, Predictor must agree (no split decisions)
   - If disagreement: HOLD

5. REGIME ALIGNMENT: Trade direction must match market regime
   - Trending bullish = only BUY
   - Trending bearish = only SELL
   - Ranging = trade to key levels only
   - Volatile = reduce position size or HOLD

6. NEWS FILTER: NO trading within 60 minutes of high-impact news
   - Check research agent for upcoming events

7. SESSION FILTER: For EUR/GBP pairs, avoid Asian session
   - Low liquidity = poor execution

═══════════════════════════════════════════════════════════════
                         ENTRY CHECKLIST (4/5 REQUIRED)
═══════════════════════════════════════════════════════════════

□ Trend alignment across timeframes (4H/1H same direction)
□ RSI not extreme (between 30-70) OR confirming reversal at extremes
□ Key support/resistance level nearby (within 20 pips for forex)
□ Momentum confirming direction (positive for BUY, negative for SELL)
□ No negative sentiment news from research agent

If fewer than 4 boxes checked: HOLD

═══════════════════════════════════════════════════════════════
                         POSITION MANAGEMENT
═══════════════════════════════════════════════════════════════

- Use the provided risk percent per trade (user configurable)
- TP1: Close 50% at 1:1 R:R, move SL to breakeven
- TP2: Close 30% at 1:2 R:R  
- TP3: Let remaining 20% run with trailing stop

═══════════════════════════════════════════════════════════════
                         TIMEFRAME SELECTION
═══════════════════════════════════════════════════════════════

Analyze data from Predictor agent (includes 5m, 15m, 1H, 4H):
- Use 4H for overall bias and major levels
- Use 1H for trend confirmation
- Use 15m for entry timing
- Use 5m for precision entries only

Recommend the timeframe with BEST risk:reward for entry.

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

  private getUserPrompt(input: OrchestratorInput): string {
    return `═══════════════════════════════════════════════════════════════
                         ANALYZE THIS SETUP
═══════════════════════════════════════════════════════════════

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

Apply the IRON RULES and ENTRY CHECKLIST. Synthesize all inputs.
Provide your trading decision as JSON.`;
  }

  private parseResponse(content: string, currentPrice: number): SignalDecision {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        const agentScores: AgentScores = {
          research: parsed.agent_scores?.research || 50,
          technical: parsed.agent_scores?.technical || 50,
          predictor: parsed.agent_scores?.predictor || 50
        };

        // Validate R:R ratio
        if (parsed.action !== 'HOLD') {
          const slDistance = Math.abs(parsed.entry_price - parsed.stop_loss);
          const tp1Distance = Math.abs(parsed.take_profit_1 - parsed.entry_price);
          
          if (tp1Distance < slDistance * 2) {
            logger.warn(`R:R ratio too low: ${(tp1Distance/slDistance).toFixed(2)}:1, rejecting signal`);
            return this.getHoldDecision(currentPrice, 'R:R ratio below 2:1 minimum');
          }
        }

        return {
          action: parsed.action || 'HOLD',
          confidence: parsed.confidence || 0,
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
