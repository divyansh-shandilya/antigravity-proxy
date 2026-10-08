/**
 * Account Manager Service
 * Manages OAuth accounts, rotation, and rate limiting
 */

import { AccountManager, type ManagedAccount } from '../lib/auth/accounts.js';
import { formatRefreshParts } from '../lib/auth/auth.js';
import { loadAccounts } from '../lib/auth/storage.js';
import { createLogger } from '../lib/logger.js';
import type { OAuthAuthDetails } from '../lib/types.js';

const log = createLogger('account-service');

export class AccountService {
  private accountManager: AccountManager | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load accounts from disk
      const stored = await loadAccounts();
      
      if (!stored || !stored.accounts || stored.accounts.length === 0) {
        log.warn('No accounts found. Run authentication first.');
        this.initialized = true;
        return;
      }

      // Create a dummy auth object from the first account to initialize AccountManager
      const firstAccount = stored.accounts[0];
      if (!firstAccount) {
        throw new Error('No valid account found');
      }

      const dummyAuth: OAuthAuthDetails = {
        type: 'oauth',
        refresh: formatRefreshParts({
          refreshToken: firstAccount.refreshToken,
          projectId: firstAccount.projectId,
          managedProjectId: firstAccount.managedProjectId,
        }),
        access: '', // Will be refreshed when needed
        expires: 0,
      };

      this.accountManager = await AccountManager.loadFromDisk(dummyAuth);
      
      // Reset any stale rate limit reset times on startup
      for (const account of this.accountManager.getAccounts()) {
        account.rateLimitResetTimes = {};
      }
      await this.accountManager.saveToDisk();

      this.initialized = true;

      log.info('Account manager initialized', {
        accountCount: this.accountManager.getAccountCount(),
      });
    } catch (error) {
      log.error('Failed to initialize account manager', {
        error: String(error),
      });
      throw error;
    }
  }

  async getAccountManager(): Promise<AccountManager> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.accountManager) {
      throw new Error('Account manager not initialized. Run authentication first.');
    }

    return this.accountManager;
  }

  async getAccountCount(): Promise<number> {
    const manager = await this.getAccountManager();
    return manager.getAccountCount();
  }

  async getAccounts(): Promise<ManagedAccount[]> {
    const manager = await this.getAccountManager();
    return manager.getAccounts();
  }

  private getModelFamily(model: string): 'claude' | 'gemini' {
    const lower = model.toLowerCase();
    if (lower.includes('claude')) {
      return 'claude';
    }
    return 'gemini';
  }

  async getNextAccount(model: string): Promise<ManagedAccount | null> {
    const manager = await this.getAccountManager();
    const count = manager.getAccountCount();
    
    // In single-account mode, always return the account so requests can proceed
    if (count <= 1) {
      return manager.getAccounts()[0] || null;
    }
    
    // Determine model family from model name
    const family = this.getModelFamily(model);
    const headerStyle = model.toLowerCase().includes('antigravity') ? 'antigravity' : 'gemini-cli';

    return manager.getCurrentOrNextForFamily(
      family,
      model,
      'hybrid', // Default strategy
      headerStyle as 'antigravity' | 'gemini-cli',
      false, // pid_offset_enabled
    );
  }

  async markRateLimited(account: ManagedAccount, delayMs: number, model: string): Promise<void> {
    const manager = await this.getAccountManager();
    const count = manager.getAccountCount();
    
    // In single-account mode, NEVER lock out the account
    if (count <= 1) {
      log.info('Single account mode: skipping rate limit marking to prevent lockout', {
        accountIndex: account.index,
        model,
      });
      return;
    }

    const family = this.getModelFamily(model);
    const headerStyle = model.toLowerCase().includes('antigravity') ? 'antigravity' : 'gemini-cli';

    manager.markRateLimited(
      account,
      delayMs,
      family,
      headerStyle as 'antigravity' | 'gemini-cli',
      model
    );

    await manager.saveToDisk();
  }

  async saveToDisk(): Promise<void> {
    if (this.accountManager) {
      await this.accountManager.saveToDisk();
    }
  }
}

// Singleton instance
export const accountService = new AccountService();
