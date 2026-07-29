// index.js
const WebSocket = require('ws');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

// Environment variables (Railway will provide these)
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
const WALLET_TO_MONITOR = process.env.WALLET_ADDRESS || 'pau23UpU2BFwF4JZrLxAnf4ZqgnD3xLnz6ESu7vPsao';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';
const PORT = process.env.PORT || 3000;

if (!HELIUS_RPC_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error('Missing required environment variables. Check Railway dashboard.');
}

console.log(`🔍 Monitoring wallet: ${WALLET_TO_MONITOR}`);
console.log(`📡 Helius RPC: ${HELIUS_RPC_URL.substring(0, 30)}...`);

// State management
const trackedTokens = new Map();
const signalHistory = [];
let signalCount = 0;

// Solana connection
const connection = new Connection(HELIUS_RPC_URL, {
  wsEndpoint: HELIUS_RPC_URL.replace('https', 'wss').replace('http', 'ws')
});

// Helper: Send Telegram message
async function sendTelegram(message, parseMode = 'Markdown') {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: parseMode,
      disable_web_page_preview: true
    });
    console.log('✅ Telegram message sent');
  } catch (err) {
    console.error('❌ Telegram error:', err.response?.data || err.message);
  }
}

// Helper: Fetch token info from DexScreener
async function getTokenInfo(mintAddress) {
  try {
    const url = `${DEXSCREENER_API}/solana/tokens/${mintAddress}`;
    const res = await axios.get(url, { timeout: 5000 });
    return res.data;
  } catch (err) {
    console.error('DexScreener fetch error:', err.message);
    return null;
  }
}

// Helper: Get market cap and volume
async function getMarketData(mintAddress) {
  const data = await getTokenInfo(mintAddress);
  if (!data || !data.token) {
    return { marketCap: 0, volume24h: 0, price: 0 };
  }
  
  return {
    marketCap: data.token.marketCap || 0,
    volume24h: data.token.volume || 0,
    price: data.token.price || 0,
    volume5m: data.token.volume5m || 0
  };
}

// Helper: Check Trench API
async function checkTrench(mintAddress) {
  try {
    const url = `https://trench.bot/api/bundle/advanced/${mintAddress}`;
    const res = await axios.get(url, { timeout: 5000 });
    const data = res.data;
    
    const bundleHoldPercent = data.bundle_hold_percent || 0;
    const insiderHoldPercent = data.insider_hold_percent || 0;
    
    if (bundleHoldPercent >= 30 || insiderHoldPercent >= 25) {
      return { 
        pass: false, 
        reason: `Trench: bundle ${bundleHoldPercent}%, insider ${insiderHoldPercent}%` 
      };
    }
    return { pass: true };
  } catch (err) {
    console.error('Trench API error:', err.message);
    return { pass: true };
  }
}

// Helper: Get top token holders via Helius
async function getTopHolders(mintAddress) {
  try {
    const url = `${HELIUS_RPC_URL.replace('wss', 'https').replace('ws', 'https')}`;
    const response = await axios.post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [mintAddress]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    const accounts = response.data.result?.value || [];
    return accounts.slice(0, 10).map(acc => ({
      owner: acc.address,
      amount: acc.amount,
      percent: (acc.amount / 1e9) * 100 // Simplified
    }));
  } catch (err) {
    console.error('Get holders error:', err.message);
    return [];
  }
}

// Helper: Check holder conditions
async function checkHolders(mintAddress) {
  try {
    const holders = await getTopHolders(mintAddress);
    
    if (holders.length < 2) {
      return { pass: true };
    }
    
    // Check if both top 2 hold 5%+
    const top2BothLarge = holders[0].percent >= 5 && holders[1].percent >= 5;
    if (top2BothLarge) {
      return { pass: false, reason: 'Top 2 holders both 5%+' };
    }
    
    // Check SOL balances
    let totalSOL = 0;
    let walletsOver0_5 = 0;
    
    for (let i = 0; i < Math.min(10, holders.length); i++) {
      try {
        const wallet = new PublicKey(holders[i].owner);
        const balance = await connection.getBalance(wallet);
        const solBalance = balance / 1e9;
        totalSOL += solBalance;
        if (solBalance >= 0.5) walletsOver0_5++;
      } catch (err) {
        // Skip if balance check fails
      }
    }
    
    if (totalSOL < 10 || walletsOver0_5 < 4) {
      return { 
        pass: false, 
        reason: `SOL: ${totalSOL.toFixed(2)} SOL total, ${walletsOver0_5} wallets >=0.5 SOL` 
      };
    }
    
    return { pass: true };
  } catch (err) {
    console.error('Holder check error:', err.message);
    return { pass: true };
  }
}

// Pre-call filters
async function applyPreCallFilters(mintAddress) {
  const marketData = await getMarketData(mintAddress);
  
  // Market cap filter
  if (marketData.marketCap < 50000 || marketData.marketCap > 350000) {
    return { 
      pass: false, 
      reason: `MC $${marketData.marketCap.toLocaleString()} outside $50K-$350K range` 
    };
  }
  
  // Volume filter
  const volume5m = marketData.volume5m || (marketData.volume24h / 288); // Estimate
  if (volume5m < 10000) {
    return { 
      pass: false, 
      reason: `5m volume $${volume5m.toLocaleString()} below $10K` 
    };
  }
  
  // Trench check
  const trenchCheck = await checkTrench(mintAddress);
  if (!trenchCheck.pass) {
    return trenchCheck;
  }
  
  // Holder check
  const holderCheck = await checkHolders(mintAddress);
  if (!holderCheck.pass) {
    return holderCheck;
  }
  
  return { pass: true, marketData };
}

// Process new token purchase
async function processNewToken(mintAddress, txSignature) {
  console.log(`
🔔 New token detected: ${mintAddress}`);
  console.log(`Transaction: https://solscan.io/tx/${txSignature}`);
  
  // Apply pre-call filters immediately
  const filters = await applyPreCallFilters(mintAddress);
  
  if (!filters.pass) {
    console.log(`❌ Filter failed: ${filters.reason}`);
    await sendTelegram(
      `❌ SKIPPED

` +
      `Token: `${mintAddress}`
` +
      `Reason: ${filters.reason}
` +
      `Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`
    );
    return;
  }
  
  const marketData = filters.marketData;
  
  // Send buy signal
  const message = 
    `🚀 *BUY SIGNAL* 🚀

` +
    `🪙 Token: `${mintAddress}`
` +
    `💰 Price: $${marketData.price}
` +
    `📊 Market Cap: $${marketData.marketCap.toLocaleString()}
` +
    `📈 24h Volume: $${marketData.volume24h.toLocaleString()}
` +
    `🔗 TX: [Solscan](https://solscan.io/tx/${txSignature})
` +
    `⏰ Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}

` +
    `⚠️ *DYOR - Not financial advice*`;
  
  await sendTelegram(message);
  
  // Track signal
  signalCount++;
  const signalData = {
    mint: mintAddress,
    tx: txSignature,
    entryMC: marketData.marketCap,
    entryPrice: marketData.price,
    timestamp: Date.now(),
    peakMC: marketData.marketCap,
    lowMC: marketData.marketCap,
    mc80min: null,
    rugAlertSent: false
  };
  
  trackedTokens.set(mintAddress, signalData);
  signalHistory.push(signalData);
  
  // Start post-signal tracking
  trackPostSignal(mintAddress);
  
  console.log(`✅ Signal #${signalCount} sent for ${mintAddress}`);
}

// Track post-signal performance
async function trackPostSignal(mintAddress) {
  const tokenData = trackedTokens.get(mintAddress);
  if (!tokenData) return;
  
  const startTime = Date.now();
  const eightyMinutes = 80 * 60 * 1000;
  let checkCount = 0;
  
  const interval = setInterval(async () => {
    const marketData = await getMarketData(mintAddress);
    const currentMC = marketData.marketCap;
    
    if (currentMC > 0) {
      // Update peak
      if (currentMC > tokenData.peakMC) {
        tokenData.peakMC = currentMC;
      }
      
      // Update low
      if (currentMC < tokenData.lowMC) {
        tokenData.lowMC = currentMC;
      }
      
      // Check for rug (-90% from entry)
      if (!tokenData.rugAlertSent && tokenData.entryMC > 0) {
        const dropPercent = ((tokenData.entryMC - currentMC) / tokenData.entryMC) * 100;
        if (dropPercent >= 90) {
          await sendTelegram(
            `🚨 *RUG ALERT* 🚨

` +
            `🪙 Token: `${mintAddress}`
` +
            `📉 Drop: ${dropPercent.toFixed(2)}%
` +
            `💰 Entry MC: $${tokenData.entryMC.toLocaleString()}
` +
            `💸 Current MC: $${currentMC.toLocaleString()}
` +
            `⏰ Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`
          );
          tokenData.rugAlertSent = true;
        }
      }
    }
    
    checkCount++;
    
    // Check if 80 minutes passed
    if (Date.now() - startTime >= eightyMinutes) {
      tokenData.mc80min = currentMC;
      
      console.log(`📊 80min complete for ${mintAddress}: Peak $${tokenData.peakMC.toLocaleString()}, Low $${tokenData.lowMC.toLocaleString()}, 80min $${currentMC.toLocaleString()}`);
      
      // Send batch report if we have 3+ completed signals
      const completedSignals = signalHistory.filter(s => s.mc80min !== null);
      if (completedSignals.length >= 3 && completedSignals.length % 3 === 0) {
        await sendBatchReport(completedSignals.slice(-3));
      }
      
      // Clean up
      trackedTokens.delete(mintAddress);
      clearInterval(interval);
    }
  }, 60000); // Check every minute
  
  console.log(`📡 Started tracking ${mintAddress} for 80 minutes`);
}

// Send batch report
async function sendBatchReport(signals) {
  let message = `📊 *BATCH REPORT* (Last 3 Signals)

`;
  
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    const roi = s.mc80min ? ((s.mc80min - s.entryMC) / s.entryMC * 100).toFixed(2) : 'N/A';
    
    message += `${i + 1}. `${s.mint.substring(0, 8)}...${s.mint.substring(s.mint.length - 8)}`
`;
    message += `   Entry: $${s.entryMC.toLocaleString()} | Peak: $${s.peakMC.toLocaleString()}
`;
    message += `   Low: $${s.lowMC.toLocaleString()} | 80min: $${s.mc80min ? s.mc80min.toLocaleString() : 'N/A'}
`;
    message += `   ROI: ${roi}% | Rug: ${s.rugAlertSent ? 'YES ⚠️' : 'NO'}

`;
  }
  
  message += `⏰ Report Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`;
  
  await sendTelegram(message);
}

// Parse transaction logs for token mint/purchase
function extractTokenMintFromLogs(logs, walletAddress) {
  try {
    // Look for initializeMint or similar instructions
    for (const log of logs) {
      if (log.includes('initializeMint') || log.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) {
        // Extract mint address from log (simplified)
        const parts = log.split(' ');
        for (const part of parts) {
          if (part.length === 44 && part !== walletAddress) {
            return part;
          }
        }
      }
    }
  } catch (err) {
    console.error('Log parsing error:', err.message);
  }
  return null;
}

// Subscribe to wallet activity using Helius enhanced API
async function subscribeToWallet() {
  const wsUrl = HELIUS_RPC_URL.replace('https', 'wss').replace('http', 'ws');
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('✅ Connected to Helius WebSocket');
    
    // Subscribe to wallet logs
    const subscription = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [WALLET_TO_MONITOR] },
        { commitment: 'confirmed' }
      ]
    };
    
    ws.send(JSON.stringify(subscription));
  });
  
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);
      
      if (parsed.params?.result?.value) {
        const value = parsed.params.result.value;
        const logs = value.logs || [];
        const signature = value.signature;
        
        // Check for pump.fun or Raydium interactions
        const isPumpOrRaydium = logs.some(log => 
          log.toLowerCase().includes('pump') || 
          log.toLowerCase().includes('raydium') ||
          log.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') // Raydium program
        );
        
        if (isPumpOrRaydium) {
          console.log('🔍 Detected pump.fun/Raydium interaction');
          console.log('Logs:', logs.slice(0, 5));
          
          // Extract token mint
          const mintAddress = extractTokenMintFromLogs(logs, WALLET_TO_MONITOR);
          
          if (mintAddress) {
            await processNewToken(mintAddress, signature);
          } else {
            console.log('⚠️ Could not extract mint address from logs');
          }
        }
      }
    } catch (err) {
      console.error('WebSocket message error:', err.message);
    }
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting...');
    setTimeout(subscribeToWallet, 5000);
  });
}

// Health check endpoint for Railway
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      wallet: WALLET_TO_MONITOR,
      signals: signalCount,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Solana Copy Trading Bot is running! 🚀');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  
  // Start WebSocket subscription
  subscribeToWallet();
  
  // Send startup notification
  setTimeout(async () => {
    await sendTelegram(
      `✅ *Bot Started*

` +
      `🔍 Monitoring: `${WALLET_TO_MONITOR}`
` +
      `📡 Railway Deployment: Active
` +
      `⏰ Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}

` +
      `You will receive signals when this wallet buys tokens on pump.fun or Raydium.`
    );
  }, 2000);
});
