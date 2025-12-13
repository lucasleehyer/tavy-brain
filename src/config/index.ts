export const config = {
  // MetaAPI
  metaapi: {
    token: process.env.METAAPI_TOKEN!,
    accountId: process.env.METAAPI_ACCOUNT_ID!,
    region: 'london'
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  },

  // AI Services
  ai: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-5'
    },
    perplexity: {
      apiKey: process.env.PERPLEXITY_API_KEY,
      model: 'sonar-pro'
    },
    lovable: {
      apiKey: process.env.LOVABLE_API_KEY,
      url: 'https://ai.gateway.lovable.dev/v1/chat/completions'
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      url: 'https://api.deepseek.com/v1/chat/completions'
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
