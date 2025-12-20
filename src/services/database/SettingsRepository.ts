import { SupabaseManager } from './SupabaseClient';
import { logger } from '../../utils/logger';
import { TradingThresholds, DEFAULT_THRESHOLDS } from '../../config/thresholds';

export class SettingsRepository {
  private supabase = SupabaseManager.getInstance().getClient();
  private cachedSettings: Map<string, number> = new Map();

  async loadSettings(): Promise<TradingThresholds> {
    try {
      const { data, error } = await this.supabase
        .from('system_settings')
        .select('*');

      if (error) throw error;

      const settings: any = { ...DEFAULT_THRESHOLDS };

      for (const row of data || []) {
        const camelKey = this.snakeToCamel(row.key);
        settings[camelKey] = row.value;
        this.cachedSettings.set(row.key, row.value);
      }

      return settings as TradingThresholds;

    } catch (error) {
      logger.error('Failed to load settings:', error);
      return DEFAULT_THRESHOLDS;
    }
  }

  async updateSetting(key: string, value: number, reason: string): Promise<void> {
    const oldValue = this.cachedSettings.get(key) || 0;

    const { error } = await this.supabase
      .from('system_settings')
      .update({
        value,
        adjustment_reason: reason,
        last_adjusted_at: new Date().toISOString()
      })
      .eq('key', key);

    if (error) {
      logger.error('Failed to update setting:', error);
      return;
    }

    // Log the change
    await this.supabase.from('system_settings_log').insert({
      setting_key: key,
      old_value: oldValue,
      new_value: value,
      reason
    });

    this.cachedSettings.set(key, value);
    logger.info(`Setting ${key} updated: ${oldValue} → ${value} (${reason})`);
  }

  getSetting(key: string): number | null {
    return this.cachedSettings.get(key) || null;
  }

  async getRiskPercent(): Promise<number> {
    const cached = this.cachedSettings.get('risk_percent_per_trade');
    if (cached !== undefined) return cached;

    const { data, error } = await this.supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'risk_percent_per_trade')
      .single();

    if (error || !data) {
      logger.warn('Risk percent setting not found, using default 10%');
      return 10;
    }

    this.cachedSettings.set('risk_percent_per_trade', data.value);
    return data.value;
  }

  async isAIEnabled(): Promise<boolean> {
    const cached = this.cachedSettings.get('ai_calls_enabled');
    if (cached !== undefined) return cached === 1;

    const { data, error } = await this.supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'ai_calls_enabled')
      .single();

    if (error || !data) return true; // Default enabled

    this.cachedSettings.set('ai_calls_enabled', data.value);
    return data.value === 1;
  }

  async getTradingAccounts(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('trading_accounts')
      .select('*')
      .eq('is_active', true)
      .eq('is_frozen', false)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to get trading accounts:', error);
      return [];
    }

    return data || [];
  }

  async getPriceSourceAccount(): Promise<{ metaapi_account_id: string; account_name: string } | null> {
    // First try price_source_accounts table
    const { data: priceSource, error: priceError } = await this.supabase
      .from('price_source_accounts')
      .select('metaapi_account_id, account_name')
      .eq('is_primary', true)
      .maybeSingle();

    if (priceSource) {
      logger.info(`Using price source from price_source_accounts: ${priceSource.account_name}`);
      return priceSource;
    }

    // Fallback to trading_accounts with is_price_source=true
    const { data: tradingAccount, error: tradingError } = await this.supabase
      .from('trading_accounts')
      .select('metaapi_account_id, account_name')
      .eq('is_price_source', true)
      .maybeSingle();

    if (tradingAccount) {
      logger.info(`Using price source from trading_accounts: ${tradingAccount.account_name}`);
      return tradingAccount;
    }

    logger.warn('No price source account found in database');
    return null;
  }

  async getActiveExecutionAccounts(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('trading_accounts')
      .select('*')
      .eq('is_active', true)
      .eq('is_frozen', false)
      .eq('is_price_source', false) // Exclude price source from execution
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to get execution accounts:', error);
      return [];
    }

    return data || [];
  }

  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }
}
