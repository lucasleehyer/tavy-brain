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

  async getTradingAccounts(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('trading_accounts')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to get trading accounts:', error);
      return [];
    }

    return data || [];
  }

  async getPriceSourceAccount(): Promise<any | null> {
    const { data, error } = await this.supabase
      .from('trading_accounts')
      .select('*')
      .eq('is_price_source', true)
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }
}
