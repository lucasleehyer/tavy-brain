import OpenAI from 'openai';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { MarketRegime } from '../../types/market';
import { SignalDecision, AgentOutputs } from '../../types/signal';
import { ANTI_SCALPING } from '../../config/thresholds';

interface OrchestratorInput {
  symbol: string;
  assetType: 'forex' | 'stock' | 'crypto';
  currentPrice: number;
  regime: MarketRegime;
  accountBalance: number;
  riskPercent: number;
  agentOutputs: AgentOutputs;
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
    // Use direct OpenAI if available, otherwise fallback to Lovable AI
    if (this.openai) {
      return this.orchestrateWithOpenAI(input);
    } else {
      return this.orchestrateWithLovableAI(input);
    }
  }

  private async orchestrateWithOpenAI(input: OrchestratorInput): Promise<SignalDecision> {
    try {
      const response = await this.openai!.chat.completions.create({
        model: 'gpt-5',
        max_completion_tokens: 2000,
        messages: [{
          role: 'system',
          content: this.getSystemPrompt(input.assetType)
        }, {
          role: 'user',
          content: this.getUserPrompt(input)
        }]
      });

      return this.parseResponse(response.choices[0].message.content || '', input.currentPrice);

    } catch (error) {
      logger.error('Master Orchestrator (OpenAI) error:', error);
      return this.getHoldDecision(input.currentPrice, `OpenAI error: ${(error as Error).message}`);
    }
  }

  private async orchestrateWithLovableAI(input: OrchestratorInput): Promise<SignalDecision> {
    try {
      const response = await fetch(config.ai.lovable.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai.lovable.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-5',
          messages: [{
            role: 'system',
            content: this.getSystemPrompt(input.assetType)
          }, {
            role: 'user',
            content: this.getUserPrompt(input)
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Lovable AI error: ${response.status}`);
      }

      const data = await response.json();
      return this.parseResponse(data.choices[0].message.content, input.currentPrice);

    } catch (error) {
      logger.error('Master Orchestrator (Lovable) error:', error);
      return this.getHoldDecision(input.currentPrice, `Lovable AI error: ${(error as Error).message}`);
    }
  }

  private getSystemPrompt(assetType: string): string {
    const rules = assetType === 'forex' || assetType === 'crypto'
      ? ANTI_SCALPING.forex
      : ANTI_SCALPING.stocks;

    return `You are the Master Orchestrator of an elite AI trading council.
Synthesize inputs from Research, Technical, and Prediction agents to make final trading decisions.

CRITICAL RULES:
- Minimum 60% confidence to trade
- TP1 minimum ${rules.minTp1Pips || rules.minTp1Percent} ${rules.minTp1Pips ? 'pips' : '%'} (anti-scalping)
- Risk:Reward must be >= ${rules.minRiskReward}:1
- Reject low-reward setups that cannot survive execution costs

Return JSON only with exact fields:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit1": number,
  "takeProfit2": number,
  "takeProfit3": number,
  "reasoning": string (concise explanation),
  "agentScores": {
    "research": number (0-100),
    "technical": number (0-100),
    "predictor": number (0-100)
  },
  "systemRecommendation": null | {
    "urgency": "low" | "medium" | "high" | "critical",
    "type": string,
    "recommendation": string,
    "can_auto_implement": boolean,
    "suggested_values": object
  }
}`;
  }

  private getUserPrompt(input: OrchestratorInput): string {
    return `Make a trading decision for ${input.symbol} (${input.assetType}):

Current Price: ${input.currentPrice}
Market Regime: ${input.regime.type} (${input.regime.direction}, strength: ${input.regime.strength}%)
Account Balance: $${input.accountBalance}
Risk Per Trade: ${input.riskPercent}%

Research Agent Output:
${JSON.stringify(input.agentOutputs.research, null, 2)}

Technical Agent Output:
${JSON.stringify(input.agentOutputs.technical, null, 2)}

Prediction Agent Output:
${JSON.stringify(input.agentOutputs.predictor, null, 2)}

Provide your final decision as JSON.`;
  }

  private parseResponse(content: string, currentPrice: number): SignalDecision {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          action: parsed.action || 'HOLD',
          confidence: parsed.confidence || 0,
          entryPrice: parsed.entryPrice || currentPrice,
          stopLoss: parsed.stopLoss || 0,
          takeProfit1: parsed.takeProfit1 || 0,
          takeProfit2: parsed.takeProfit2 || 0,
          takeProfit3: parsed.takeProfit3 || 0,
          reasoning: parsed.reasoning || 'No reasoning provided',
          agentOutputs: {} as any,
          agentScores: parsed.agentScores || { research: 0, technical: 0, predictor: 0 },
          systemRecommendation: parsed.systemRecommendation
        };
      }
      throw new Error('No JSON found in response');
    } catch (error) {
      logger.error('Failed to parse orchestrator response:', content);
      return this.getHoldDecision(currentPrice, 'Failed to parse AI response');
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
      agentOutputs: {} as any,
      agentScores: { research: 0, technical: 0, predictor: 0 }
    };
  }
}
