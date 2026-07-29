// index.js
const WebSocket = require('ws');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

// Environment variables
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
const WALLET_TO_MONITOR = process.env.WALLET_ADDRESS || 'pau23UpU2BFwF4JZrLxAnf4ZqgnD3xLnz6ESu7vPsao';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// Validate environment
if (!HELIUS_RPC_URL) {
  console.error('❌ Missing HELIUS_RPC_URL');
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Missing Telegram credentials');
  process.exit(1);
}

console.log('🚀 Starting Solana Copy Trading Bot...');
console.log(`🔍 Monitoring: ${WALLET_TO_MONITOR}`);

// State
const trackedTokens = new Map();
const signalHistory = [];
let signalCount = 0;

// Connection
const solanaRpcUrl = HELIUS_RPC_URL.replace('wss', 'https').replace('ws', 'https');
const connection = new Connection(solanaRpcUrl, { commitment: 'confirmed' });

// Telegram
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram sent');
  } catch (err) {
    console.error('❌ Telegram error:', err.response?.data?.description || err.message);
  }
}

// DexScreener
async function getTokenInfo(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/solana/tokens/${mint}`, { 
      timeout: 5000 
    });
    return res.data;
  } catch (err) {
    return null;
  }
}

async function getMarketData(mint) {
  const data = await getTokenInfo(mint);
  if (!data?.token) {
    return { marketCap: 0, volume24h: 0, price: 0, volume5m: 0 };
  }
  
  return {
    marketCap: data.token.marketCap || 0,
    volume24h: data.token.volume || 0,
    price: data.token.price || 0,
    volume5m: data.token.volume5m || 0
  };
}

// Filters
async function checkTrench(mint) {
  try {
    const res = await axios.get(`https://trench.bot/api/bundle/advanced/${mint}`, { timeout: 5000 });
    const { bundle_hold_percent = 0, insider_hold_percent = 0 } = res.data || {};
    
    if (bundle_hold_percent >= 30 || insider_hold_percent >= 25) {
      return { pass: false, reason: `Trench: bundle ${bundle_hold_percent}%, insider ${insider_hold_percent}%` };
    }
    return { pass: true };
  } catch (err) {
    console.error('Trench error:', err.message);
    return { pass: true };
  }
}

async function checkHolders(mint) {
  try {
    const url = solanaRpcUrl;
    const response = await axios.post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [mint]
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    
    const accounts = response.data.result?.value || [];
    const top10 = accounts.slice(0, 10);
    
    if (top10.length < 2) return { pass: true };
    
    // Top 2 both 5%+
    const p0 = top10[0].amount / 1e9;
    const p1 = top10[1].amount / 1e9;
    if (p0 >= 5 && p1 >= 5) {
      return { pass: false, reason: 'Top 2 holders both 5%+' };
    }
    
    // SOL balances
    let totalSOL = 0;
    let over0_5 = 0;
    
    for (let i = 0; i < Math.min(10, top10.length); i++) {
      try {
        const wallet = new PublicKey(top10[i].address);
        const balance = await connection.getBalance(wallet);
        const sol = balance / 1e9;
        totalSOL += sol;
        if (sol >= 0.5) over0_5++;
      } catch (e) {
        // skip
      }
    }
    
    if (totalSOL < 10 || over0_5 < 4) {
      return { pass: false, reason: `SOL: ${totalSOL.toFixed(1)} total, ${over0_5} >=0.5` };
    }
    
    return { pass: true };
  } catch (err) {
    console.error('Holders error:', err.message);
    return { pass: true };
  }
}

async function applyFilters(mint) {
  const marketData = await getMarketData(mint);
  
  // MC filter
  if (marketData.marketCap < 50000 || marketData.marketCap > 350000) {
    return { pass: false, reason: `MC $${marketData.marketCap.toLocaleString()} outside range` };
  }
  
  // Volume filter
  const vol5m = marketData.volume5m || (marketData.volume24h / 288);
  if (vol5m < 10000) {
    return { pass: false, reason: `5m vol $${vol5m.toLocaleString()} < $10K` };
  }
  
  // Trench
  const trench = await checkTrench(mint);
  if (!trench.pass) return trench;
  
  // Holders
  const holders = await checkHolders(mint);
  if (!holders.pass) return holders;
  
  return { pass: true, marketData };
}

// Process token
async function processToken(mint, tx) {
  console.log(`
🔔 New token: ${mint}`);
  
  const filters = await applyFilters(mint);
  
  if (!filters.pass) {
    console.log(`❌ Filter: ${filters.reason}`);
    await sendTelegram(
      `❌ SKIPPED

` +
      `Token: `${mint}`
` +
      `Reason: ${filters.reason}
` +
      `Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`
    );
    return;
  }
  
  const md = filters.marketData;
  
  // Send signal
  const msg = 
    `🚀 *BUY SIGNAL*

` +
    `🪙 Token: `${mint}`
` +
    `💰 Price: $${md.price}
` +
    `📊 MC: $${md.marketCap.toLocaleString()}
` +
    `📈 Vol24h: $${md.volume24h.toLocaleString()}
` +
    `🔗 TX: [Solscan](https://solscan.io/tx/${tx})
` +
    `⏰ ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}

` +
    `⚠️ DYOR`;
  
  await sendTelegram(msg);
  
  // Track
  signalCount++;
  const data = {
    mint,
    tx,
    entryMC: md.marketCap,
    entryPrice: md.price,
    timestamp: Date.now(),
    peakMC: md.marketCap,
    lowMC: md.marketCap,
    mc80min: null,
    rugAlertSent: false
  };
  
  trackedTokens.set(mint, data);
  signalHistory.push(data);
  
  // Track post
  trackPost(mint);
  
  console.log(`✅ Signal #${signalCount}`);
}

async function trackPost(mint) {
  const tokenData = trackedTokens.get(mint);
  if (!tokenData) return;
  
  const start = Date.now();
  const eightyMin = 80 * 60 * 1000;
  
  const interval = setInterval(async () => {
    const md = await getMarketData(mint);
    const mc = md.marketCap;
    
    if (mc > 0) {
      if (mc > tokenData.peakMC) tokenData.peakMC = mc;
      if (mc < tokenData.lowMC) tokenData.lowMC = mc;
      
      // Rug check
      if (!tokenData.rugAlertSent && tokenData.entryMC > 0) {
        const drop = ((tokenData.entryMC - mc) / tokenData.entryMC) * 100;
        if (drop >= 90) {
          await sendTelegram(
            `🚨 *RUG ALERT*

` +
            `🪙 `${mint}`
` +
            `📉 -${drop.toFixed(2)}%
` +
            `Entry: $${tokenData.entryMC.toLocaleString()}
` +
            `Now: $${mc.toLocaleString()}`
          );
          tokenData.rugAlertSent = true;
        }
      }
    }
    
    if (Date.now() - start >= eightyMin) {
      tokenData.mc80min = mc;
      console.log(`📊 80min done: ${mint}`);
      
      const completed = signalHistory.filter(s => s.mc80min !== null);
      if (completed.length >= 3 && completed.length % 3 === 0) {
        await sendBatchReport(completed.slice(-3));
      }
      
      trackedTokens.delete(mint);
      clearInterval(interval);
    }
  }, 60000);
}

async function sendBatchReport(signals) {
  let msg = `📊 *BATCH REPORT*

`;
  
  signals.forEach((s, i) => {
    const roi = s.mc80min ? ((s.mc80min - s.entryMC) / s.entryMC * 100).toFixed(2) : 'N/A';
    msg += `${i + 1}. `${s.mint.slice(0, 8)}...${s.mint.slice(-8)}`
`;
    msg += `   Entry: $${s.entryMC.toLocaleString()} | Peak: $${s.peakMC.toLocaleString()}
`;
    msg += `   Low: $${s.lowMC.toLocaleString()} | 80min: $${s.mc80min ? s.mc80min.toLocaleString() : 'N/A'}
`;
    msg += `   ROI: ${roi}% | Rug: ${s.rugAlertSent ? 'YES ⚠️' : 'NO'}

`;
  });
  
  await sendTelegram(msg);
}

// Extract mint from logs
function extractMint(logs, wallet) {
  try {
    for (const log of logs) {
      if (log.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) {
        const parts = log.split(' ');
        for (const part of parts) {
          if (part.length === 44 && part !== wallet) {
            return part;
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// WebSocket
async function subscribeWallet() {
  const wsUrl = HELIUS_RPC_URL.replace('https', 'wss').replace('http', 'ws');
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    const sub = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [WALLET_TO_MONITOR] },
        { commitment: 'confirmed' }
      ]
    };
    
    ws.send(JSON.stringify(sub));
  });
  
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);
      
      if (parsed.params?.result?.value) {
        const value = parsed.params.result.value;
        const logs = value.logs || [];
        const sig = value.signature;
        
        const isTarget = logs.some(log => 
          log.toLowerCase().includes('pump') || 
          log.toLowerCase().includes('raydium') ||
          log.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
        );
        
        if (isTarget) {
          console.log('🔍 Detected interaction');
          const mint = extractMint(logs, WALLET_TO_MONITOR);
          
          if (mint) {
            await processToken(mint, sig);
          } else {
            console.log('⚠️ No mint extracted');
          }
        }
      }
    } catch (err) {
      console.error('WS error:', err.message);
    }
  });
  
  ws.on('error', (err) => {
    console.error('❌ WS error:', err.message);
  });
  
  ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(subscribeWallet, 5000);
  });
}

// HTTP server
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
    res.end('Bot running! 🚀');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  
  subscribeWallet();
  
  setTimeout(async () => {
    await sendTelegram(
      `✅ *Bot Started*

` +
      `🔍 Monitoring: `${WALLET_TO_MONITOR}`
` +
      `📡 Railway: Active
` +
      `⏰ ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`
    );
  }, 2000);
});
