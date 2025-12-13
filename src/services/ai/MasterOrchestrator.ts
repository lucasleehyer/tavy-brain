import OpenAI from 'openai';
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
  private openai: OpenAI | null = null;

  constructor() {
    if (config.ai.openai.apiKey) {
      this.openai = new OpenAI({
        apiKey: config.ai.openai.apiKey
      });
    }
  }

  async orchestrate(input: OrchestratorInput): Promise<SignalDecision> {
    if (!this.openai) {
      logger.warn('OpenAI API key not configured for MasterOrchestrator');
      return this.getHoldDecision(input.currentPrice, 'OpenAI not configured');
    }

    try {
      return await this.orchestrateWithOpenAI(input);
    } catch (error) {
      logger.error('Master Orchestrator error:', error);
      return this.getHoldDecision(input.currentPrice, 'Orchestration error');
    }
  }

  private async orchestrateWithOpenAI(input: OrchestratorInput): Promise<SignalDecision> {
    const response = await this.openai!.chat.completions.create({
      model: config.ai.openai.model,
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: this.getSystemPrompt(input.assetType) },
        { role: 'user', content: this.getUserPrompt(input) }
      ]
    });

    const content = response.choices[0].message.content || '';
    return this.parseResponse(content, input.currentPrice);
  }

  private getSystemPrompt(assetType: string): string {
    let antiScalpingRule: string;
    if (assetType === 'forex') {
      antiScalpingRule = '20 pips minimum for forex, 50 pips for metals (XAU/XAG)';
    } else if (assetType === 'stock') {
      antiScalpingRule = '0.5% minimum move for stocks';
    } else {
      antiScalpingRule = '1.0% minimum move for crypto';
    }

    return `You are the Master Trading Orchestrator for TAVY, synthesizing inputs from Research, Technical, and Prediction agents to make final trading decisions.

CRITICAL TRADING RULES:
1. Anti-scalping: TP1 must be at least ${antiScalpingRule}
2. Risk/Reward: TP1 must be >= 1x the stop loss distance
3. Confidence: Only recommend BUY/SELL if confidence >= 60%
4. Regime alignment: Trade direction must align with market regime

OUTPUT FORMAT (JSON only):
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "entry_price": number,
  "stop_loss": number,
  "take_profit_1": number,
  "take_profit_2": number,
  "take_profit_3": number,
  "reasoning": "string explaining the decision",
  "agent_scores": {
    "research": 0-100,
    "technical": 0-100,
    "predictor": 0-100
  }
}`;
  }

  private getUserPrompt(input: OrchestratorInput): string {
    return `Analyze and decide on ${input.symbol} (${input.assetType}):

CURRENT PRICE: ${input.currentPrice}
MARKET REGIME: ${JSON.stringify(input.regime)}

RESEARCH AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.research, null, 2)}

TECHNICAL AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.technical, null, 2)}

PREDICTOR AGENT OUTPUT:
${JSON.stringify(input.agentOutputs.predictor, null, 2)}

ACCOUNT CONTEXT:
- Balance: $${input.accountBalance}
- Risk per trade: ${input.riskPercent}%

Synthesize all inputs and provide your trading decision as JSON.`;
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