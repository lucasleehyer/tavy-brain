# TAVY Brain

> Last updated: December 13, 2025

Real-time AI trading signal processing and execution system.

## Overview

TAVY Brain is a Node.js application that connects to MetaTrader 5 via MetaAPI WebSocket for real-time price streaming, processes signals through an AI Trading Council, and executes trades automatically.

## Features

- **Real-time WebSocket** connection to MetaAPI for tick-by-tick price data
- **AI Trading Council** with multiple specialized agents:
  - Research Agent (Perplexity) - Market sentiment and news analysis
  - Technical Agent (Gemini) - Chart pattern and indicator analysis
  - Predictor Agent (GPT-5) - Short-term price predictions
  - Master Orchestrator (GPT-5) - Final trading decisions
- **Pre-filtering** using technical indicators (RSI, ADX, ATR, Momentum)
- **Automated execution** on MetaTrader 5 accounts
- **Position monitoring** with SL/TP management
- **Real-time Supabase sync** for settings and data persistence
- **Email alerts** for critical events

## Architecture

```
MetaAPI WebSocket → Price Cache → Pre-Filter → AI Council → Execution Router → MetaAPI
        ↓                                           ↓
   Candle Builder                              Supabase DB
```

## Quick Start

### Prerequisites

- Node.js 18+
- MetaAPI account with MT5 connection
- Supabase project
- API keys for OpenAI, Perplexity, etc.

### Installation

```bash
# Clone the repository
git clone https://github.com/your-repo/tavy-brain.git
cd tavy-brain

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your API keys
nano .env

# Build
npm run build

# Start
npm start
```

### Development

```bash
# Run with hot-reload
npm run dev
```

## Deployment

### Railway.app

1. Push code to GitHub
2. Create new Railway project from GitHub repo
3. Add environment variables in Railway dashboard
4. Deploy automatically

### Docker

```bash
docker build -t tavy-brain .
docker run -d --env-file .env tavy-brain
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `METAAPI_TOKEN` | MetaAPI access token | Yes |
| `METAAPI_ACCOUNT_ID` | MT5 account ID in MetaAPI | Yes |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `PERPLEXITY_API_KEY` | Perplexity API key | Recommended |
| `LOVABLE_API_KEY` | Lovable AI Gateway key | Yes |
| `RESEND_API_KEY` | Resend email API key | Optional |
| `FOREX_PAIRS` | Comma-separated pair list | Optional |
| `RISK_PERCENT` | Risk per trade (default: 5) | Optional |
| `MIN_CONFIDENCE` | Min signal confidence (default: 60) | Optional |

## API Endpoints

### Health Check

```
GET /health
```

Returns system status including WebSocket connection, uptime, and pending signals.

## License

Proprietary - All rights reserved.
