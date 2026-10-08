#!/usr/bin/env node

/**
 * Standalone Authentication Script for Antigravity Proxy
 * Allows logging in without OpenCode dependency.
 */

import http from 'http';
import { URL } from 'url';
import { authorizeAntigravity, exchangeAntigravity } from '../src/lib/antigravity/oauth.js';
import { AccountManager } from '../src/lib/auth/accounts.js';
import { loadAccounts } from '../src/lib/auth/storage.js';
import { createLogger } from '../src/lib/logger.js';
import { formatRefreshParts } from '../src/lib/auth/auth.js';

const log = createLogger('auth-cli');

const PORT = 51121;

async function main() {
  console.log('');
  console.log('🔐 OpenAI Proxy for Antigravity Authentication');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  let isProcessing = false;
  let isDone = false;
  let activeVerifier = "";

  // 1. Start local server for callback
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    
    if (reqUrl.pathname !== '/oauth-callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (isDone) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication Successful!</h1><p>You can close this window now.</p>');
      return;
    }

    if (isProcessing) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Processing...</h1><p>Token exchange is in progress, please wait a moment.</p>');
      return;
    }
    isProcessing = true;

    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authentication Failed</h1><p>Error: ${error}</p>`);
      console.error('❌ Authentication failed:', error);
      process.exit(1);
      return;
    }

    if (!code || !state) {
      res.writeHead(400);
      res.end('Missing code or state');
      isProcessing = false;
      return;
    }

    try {
      console.log('✓ Callback received, exchanging tokens...');
      
      // 3. Exchange code for tokens
      const result = await exchangeAntigravity(code, state, activeVerifier);

      if (result.type === 'failed') {
        isProcessing = false;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication Failed</h1><p>Token exchange failed: ${result.error}</p>`);
        console.error('❌ Token exchange failed:', result.error);
        process.exit(1);
        return;
      }

      isDone = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication Successful!</h1><p>You can close this window now.</p><script>window.close()</script>');

      console.log('✓ Tokens retrieved');
      console.log(`  Project ID: ${result.projectId || '(none)'}`);
      console.log(`  Email: ${result.email || '(unknown)'}`);

      // 4. Save account
      const stored = await loadAccounts();
      
      const authDetails = {
        type: 'oauth' as const,
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
      };

      const manager = new AccountManager(authDetails, stored);
      
      const accounts = manager.getAccounts();
      const newAccount = accounts.find(a => a.parts.refreshToken === result.refresh.split('|')[0]);
      if (newAccount && result.email) {
        newAccount.email = result.email;
      }

      await manager.saveToDisk();
      
      console.log('');
      console.log('✅ Account saved successfully!');
      console.log(`   Config location: ${process.env.CONFIG_DIR || '~/.config/antigravity-proxy'}`);
      console.log('');
      
      server.close();
      process.exit(0);

    } catch (err) {
      isProcessing = false;
      console.error('❌ Error during exchange:', err);
      process.exit(1);
    }
  });

  server.listen(PORT, async () => {
    // 2. Generate URL and open browser
    const authResult = await authorizeAntigravity();
    activeVerifier = authResult.verifier;
    const { url } = authResult;
    
    console.log(`Listening on http://localhost:${PORT}`);
    console.log('Opening browser...');
    console.log('');
    console.log('👉 If browser does not open, visit this URL manually:');
    console.log(url);
    console.log('');

    const open = (await import('open')).default;
    await open(url);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
