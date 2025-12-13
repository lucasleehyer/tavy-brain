import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export class SupabaseManager {
  private client: SupabaseClient;
  private static instance: SupabaseManager;

  private constructor() {
    this.client = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey
    );
  }

  static getInstance(): SupabaseManager {
    if (!SupabaseManager.instance) {
      SupabaseManager.instance = new SupabaseManager();
    }
    return SupabaseManager.instance;
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  // Real-time settings subscription
  subscribeToSettings(callback: (settings: any) => void): void {
    this.client
      .channel('system_settings_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'system_settings'
        },
        (payload) => {
          logger.info('Settings updated via realtime');
          callback(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          logger.info('Subscribed to settings changes');
        }
      });
  }

  // Real-time trading accounts subscription
  subscribeToTradingAccounts(callback: (account: any) => void): void {
    this.client
      .channel('trading_accounts_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trading_accounts'
        },
        (payload) => {
          logger.info('Trading account updated');
          callback(payload.new);
        }
      )
      .subscribe();
  }
}
