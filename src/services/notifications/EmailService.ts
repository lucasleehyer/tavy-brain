import { logger } from '../../utils/logger';
import { config } from '../../config';

interface EmailOptions {
  to?: string;
  subject: string;
  html: string;
}

export class EmailService {
  private apiKey: string | undefined;
  private defaultTo: string;

  constructor() {
    this.apiKey = config.notifications.resendApiKey;
    this.defaultTo = config.notifications.alertEmail;
  }

  async send(options: EmailOptions): Promise<boolean> {
    if (!this.apiKey) {
      logger.warn('Resend API key not configured, skipping email');
      return false;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'TAVY Brain <noreply@tavy.io>',
          to: options.to || this.defaultTo,
          subject: options.subject,
          html: options.html
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Resend API error: ${error}`);
      }

      logger.info(`Email sent: ${options.subject}`);
      return true;

    } catch (error) {
      logger.error('Failed to send email:', error);
      return false;
    }
  }
}
