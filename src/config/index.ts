export const config = {
  // MetaAPI
  metaapi: {
    token: process.env.METAAPI_TOKEN!,
    accountId: process.env.METAAPI_ACCOUNT_ID!,
    region: 'london'
  },

  // Supabase (using anon key + service account auth)
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceEmail: process.env.TAVY_SERVICE_EMAIL!,
    servicePassword: process.env.TAVY_SERVICE_PASSWORD!
  },

  // AI Services
  ai: {
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      chatModel: 'deepseek-chat',        // V3.2 for technical/predictor
      reasonerModel: 'deepseek-reasoner' // For critical decisions
    },
    perplexity: {
      apiKey: process.env.PERPLEXITY_API_KEY,
      model: 'sonar-pro'  // Keep for ResearchAgent (real-time web)
    },
    google: {
      apiKey: process.env.GOOGLE_API_KEY,
      model: 'gemini-2.5-flash'  // Fallback only
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o'  // Fallback only
    }
  },

  // Notifications
  notifications: {
    resendApiKey: process.env.RESEND_API_KEY,
    alertEmail: process.env.ALERT_EMAIL || 'admin@example.com'
  },

  // Trading
  trading: {
    riskPercent: parseFloat(process.env.RISK_PERCENT || '5'),
    minConfidence: parseInt(process.env.MIN_CONFIDENCE || '60'),
    minLotSize: 0.01,
    maxLotSize: 10.0
  },

  // Cache
  cache: {
    priceTtlMs: 30000,
    candleTtlMs: 60000,
    settingsTtlMs: 300000
  }
};
