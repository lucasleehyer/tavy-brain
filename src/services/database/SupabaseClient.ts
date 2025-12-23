import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export class SupabaseManager {
  private client: SupabaseClient;
  private static instance: SupabaseManager;
  private isAuthenticated = false;
  private userId: string | null = null;

  private constructor() {
    // Use anon key instead of service role key
    this.client = createClient(
      config.supabase.url,
      config.supabase.anonKey
    );
  }

  static getInstance(): SupabaseManager {
    if (!SupabaseManager.instance) {
      SupabaseManager.instance = new SupabaseManager();
    }
    return SupabaseManager.instance;
  }

  // Initialize with service account authentication
  async initialize(): Promise<void> {
    if (this.isAuthenticated) {
      logger.info('Already authenticated to Supabase');
      return;
    }

    try {
      const { data, error } = await this.client.auth.signInWithPassword({
        email: config.supabase.serviceEmail,
        password: config.supabase.servicePassword
      });

      if (error) {
        throw error;
      }

      this.isAuthenticated = true;
      this.userId = data.user?.id || null;
      logger.info(`Authenticated to Supabase as ${data.user?.email} (ID: ${this.userId})`);
    } catch (error) {
      logger.error('Failed to authenticate to Supabase:', error);
      throw error;
    }
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  isReady(): boolean {
    return this.isAuthenticated;
  }

  getUserId(): string {
    if (!this.userId) {
      throw new Error('Not authenticated - no user ID available');
    }
    return this.userId;
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

// Convenience export for consumers
export const supabase = SupabaseManager.getInstance().getClient();

// Re-export SupabaseClient type for consumers
export { SupabaseClient } from '@supabase/supabase-js';
