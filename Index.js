/**
 * Solana Copy-Trading Signal Bot
 * ================================
 * Watches a wallet via Helius WebSocket. When it buys a token on pump.fun
 * or Raydium, the bot:
 *
 *   1. Fetches 180x 1-minute candles from GeckoTerminal to find the ATH.
 *   2. Arms once price is 30%+ below ATH and recovering.
 *   3. Sends a Telegram buy signal once price recovers to ATH +10%,
 *      gated behind pre-call risk filters (market cap, 5m volume,
 *      Trench.bot bundle/insider %, holder concentration, holder SOL
 *      balances).
 *   4. After the signal, tracks post-call performance for 80 minutes
 *      (peak MC, pre-peak low MC, MC at 80min, instant rug alerts),
 *      batches a report every 3 completed calls, then resets using the
 *      post-call peak as a new ATH to watch for a second call.
 *
 * This is a signal/alert bot only — it never places trades or moves funds.
 *
 * All config comes from environment variables — see .env.example.
 * Deploy on Railway by connecting this GitHub repo; set the env vars in
 * the Railway dashboard's Variables tab (see README.md).
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

// ============================================================================
// Config
// ============================================================================

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const config = {
  walletAddress: required("WALLET_ADDRESS"),
  heliusRpcUrl: required("HELIUS_RPC_URL"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),

  athCandleCount: Number(process.env.ATH_CANDLE_COUNT || 180),
  dipThreshold: Number(process.env.DIP_THRESHOLD || 0.30),
  recoveryThreshold: Number(process.env.RECOVERY_THRESHOLD || 0.10),
  pricePollIntervalMs: Number(process.env.PRICE_POLL_INTERVAL_MS || 15000),
  recoveryTicksRequired: Number(process.env.RECOVERY_TICKS_REQUIRED || 2),

  // Pre-call filters
  filterMcMin: Number(process.env.FILTER_MC_MIN || 50_000),
  filterMcMax: Number(process.env.FILTER_MC_MAX || 350_000),
  filterMinVolume5m: Number(process.env.FILTER_MIN_VOLUME_5M || 10_000),

  filterMaxBundlePct: Number(process.env.FILTER_MAX_BUNDLE_PCT || 30),
  filterMaxInsiderPct: Number(process.env.FILTER_MAX_INSIDER_PCT || 25),
  trenchApiBase: process.env.TRENCH_API_BASE || "https://trench.bot/api",

  filterTop2HolderPct: Number(process.env.FILTER_TOP2_HOLDER_PCT || 5),

  filterTopHoldersN: Number(process.env.FILTER_TOP_HOLDERS_N || 10),
  filterMinCombinedSol: Number(process.env.FILTER_MIN_COMBINED_SOL || 10),
  filterMinWalletSol: Number(process.env.FILTER_MIN_WALLET_SOL || 0.5),
  filterMinWalletsWithSol: Number(process.env.FILTER_MIN_WALLETS_WITH_SOL || 4),

  // Post-call tracking
  candlePollIntervalMs: Number(process.env.CANDLE_POLL_INTERVAL_MS || 60_000),
  postCallCandleLookback: Number(process.env.POST_CALL_CANDLE_LOOKBACK || 5),
  postCallDurationMinutes: Number(process.env.POST_CALL_DURATION_MINUTES || 80),
  rugDropPct: Number(process.env.RUG_DROP_PCT || 0.90),
  batchReportSize: Number(process.env.BATCH_REPORT_SIZE || 3),
};

// Known DEX / launchpad program IDs used to recognize a "buy" transaction.
const WATCHED_PROGRAM_IDS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1", // Raydium CPMM
]);

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ============================================================================
// Logger
// ============================================================================

function ts() {
  return new Date().toISOString();
}
const logger = {
  info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
};

// ============================================================================
// Shared Helius connection
// ============================================================================

function deriveWsEndpoint(httpUrl) {
  return httpUrl.replace(/^http/i, "ws");
}

let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.heliusRpcUrl, {
      wsEndpoint: deriveWsEndpoint(config.heliusRpcUrl),
      commitment: "confirmed",
    });
  }
  return _connection;
}

// ============================================================================
// DexScreener client (live price/MC snapshots)
// ============================================================================

async function fetchPairMarketData(pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`DexScreener market data fetch failed (${res.status}) for ${pairAddress}`);
      return null;
    }
    const data = await res.json();
    const pair = data.pair || (data.pairs || [])[0];
    if (!pair) return null;

    const priceUsd = Number(pair.priceUsd);
    const marketCapUsd = Number(pair.marketCap ?? pair.fdv);
    if (!Number.isFinite(priceUsd) || !Number.isFinite(marketCapUsd) || priceUsd <= 0) return null;

    return { priceUsd, marketCapUsd, symbol: pair.baseToken?.symbol || null };
  } catch (err) {
    logger.warn(`DexScreener market data error for ${pairAddress}:`, err.message);
    return null;
  }
}

// ============================================================================
// GeckoTerminal client (pool lookup, ATH candles, live price/MC/volume)
// ============================================================================

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

async function findPoolForToken(mint) {
  const url = `${GECKO_BASE}/networks/solana/tokens/${mint}/pools?page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`GeckoTerminal pool lookup failed (${res.status}) for ${mint}`);
      return null;
    }
    const json = await res.json();
    const pools = json?.data || [];
    if (pools.length === 0) return null;

    const best = pools.reduce((a, b) => {
      const aLiq = Number(a?.attributes?.reserve_in_usd || 0);
      const bLiq = Number(b?.attributes?.reserve_in_usd || 0);
      return bLiq > aLiq ? b : a;
    });

    return {
      poolAddress: best.attributes.address,
      priceUsd: Number(best.attributes.base_token_price_usd || 0),
    };
  } catch (err) {
    logger.warn(`GeckoTerminal pool lookup error for ${mint}:`, err.message);
    return null;
  }
}

async function fetchAthFromCandles(poolAddress, count = config.athCandleCount) {
  const limit = Math.min(count, 1000);
  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`GeckoTerminal OHLCV fetch failed (${res.status}) for pool ${poolAddress}`);
      return null;
    }
    const json = await res.json();
    const candles = json?.data?.attributes?.ohlcv_list || [];
    if (candles.length === 0) return null;

    const highs = candles.map((c) => Number(c[2])).filter((h) => Number.isFinite(h) && h > 0);
    if (highs.length === 0) return null;
    return Math.max(...highs);
  } catch (err) {
    logger.warn(`GeckoTerminal OHLCV error for pool ${poolAddress}:`, err.message);
    return null;
  }
}

async function fetchRecentCandles(poolAddress, limit = 5) {
  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`GeckoTerminal recent candles fetch failed (${res.status}) for pool ${poolAddress}`);
      return null;
    }
    const json = await res.json();
    const raw = json?.data?.attributes?.ohlcv_list || [];
    return raw
      .map((c) => ({
        timestamp: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      }))
      .filter((c) => Number.isFinite(c.high) && Number.isFinite(c.low))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    logger.warn(`GeckoTerminal recent candles error for pool ${poolAddress}:`, err.message);
    return null;
  }
}

async function fetchPoolMarketData(poolAddress) {
  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`GeckoTerminal market data fetch failed (${res.status}) for pool ${poolAddress}`);
      return null;
    }
    const json = await res.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;

    const marketCapUsd = Number(attrs.market_cap_usd ?? attrs.fdv_usd ?? NaN);
    const volume5mUsd = Number(attrs.volume_usd?.m5 ?? NaN);
    const priceUsd = Number(attrs.base_token_price_usd ?? NaN);

    return {
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
      volume5mUsd: Number.isFinite(volume5mUsd) ? volume5mUsd : null,
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    };
  } catch (err) {
    logger.warn(`GeckoTerminal market data error for pool ${poolAddress}:`, err.message);
    return null;
  }
}

async function fetchPoolPrice(poolAddress) {
  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`GeckoTerminal price fetch failed (${res.status}) for pool ${poolAddress}`);
      return null;
    }
    const json = await res.json();
    const price = Number(json?.data?.attributes?.base_token_price_usd);
    return Number.isFinite(price) ? price : null;
  } catch (err) {
    logger.warn(`GeckoTerminal price error for pool ${poolAddress}:`, err.message);
    return null;
  }
}

// ============================================================================
// Trench.bot client (bundle / insider risk)
// ============================================================================

function pickNumeric(obj, candidates) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of candidates) {
    if (obj[key] != null && !Number.isNaN(Number(obj[key]))) return Number(obj[key]);
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = pickNumeric(value, candidates);
      if (found != null) return found;
    }
  }
  return null;
}

// Trench.bot's exact response schema isn't formally documented, so this
// checks several plausible field-name variants. If filters keep reporting
// "trench bundle data unavailable," inspect a live response and add the
// real field names here.
const BUNDLE_PCT_KEYS = [
  "bundle_percentage",
  "bundlePercentage",
  "bundle_supply_percentage",
  "total_bundled_percentage",
  "totalBundledPercentage",
  "bundled_percent",
  "percent_bundled",
];
const INSIDER_PCT_KEYS = [
  "insider_percentage",
  "insiderPercentage",
  "insider_supply_percentage",
  "total_insider_percentage",
  "totalInsiderPercentage",
  "insider_percent",
  "percent_insider",
];

async function fetchTrenchBundleData(mint) {
  const url = `${config.trenchApiBase}/bundle/advanced/${mint}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`Trench bundle lookup failed (${res.status}) for ${mint}`);
      return null;
    }
    const json = await res.json();
    const bundlePct = pickNumeric(json, BUNDLE_PCT_KEYS);
    const insiderPct = pickNumeric(json, INSIDER_PCT_KEYS);

    if (bundlePct == null && insiderPct == null) {
      logger.warn(
        `Trench response for ${mint} didn't match any known field names; update BUNDLE_PCT_KEYS/INSIDER_PCT_KEYS.`
      );
      return null;
    }
    return { bundlePct: bundlePct ?? 0, insiderPct: insiderPct ?? 0 };
  } catch (err) {
    logger.warn(`Trench bundle lookup error for ${mint}:`, err.message);
    return null;
  }
}

// ============================================================================
// Helius top-holder lookup (supply concentration + SOL balances)
// ============================================================================

async function getTopHolders(mint, n = 10) {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mint);

  let largest;
  let supplyInfo;
  try {
    [largest, supplyInfo] = await Promise.all([
      connection.getTokenLargestAccounts(mintPubkey, "confirmed"),
      connection.getTokenSupply(mintPubkey, "confirmed"),
    ]);
  } catch (err) {
    logger.warn(`getTokenLargestAccounts/getTokenSupply failed for ${mint}:`, err.message);
    return null;
  }

  const totalSupply = Number(supplyInfo?.value?.uiAmount || 0);
  if (!totalSupply) {
    logger.warn(`Zero/unknown total supply for ${mint}; cannot compute holder %.`);
    return null;
  }

  const topAccounts = (largest?.value || []).slice(0, n);
  if (topAccounts.length === 0) return null;

  const ataPubkeys = topAccounts.map((a) => new PublicKey(a.address));
  let accountInfos;
  try {
    accountInfos = await connection.getMultipleParsedAccounts(ataPubkeys, { commitment: "confirmed" });
  } catch (err) {
    logger.warn(`Failed to resolve token account owners for ${mint}:`, err.message);
    return null;
  }

  const holders = topAccounts.map((acct, i) => {
    const parsed = accountInfos?.value?.[i]?.data?.parsed?.info;
    return {
      ataAddress: acct.address,
      owner: parsed?.owner || null,
      uiAmount: Number(acct.uiAmount || 0),
      pctOfSupply: totalSupply > 0 ? (Number(acct.uiAmount || 0) / totalSupply) * 100 : 0,
      solBalance: null,
    };
  });

  const owners = holders.filter((h) => h.owner);
  const balanceResults = await Promise.allSettled(
    owners.map((h) => connection.getBalance(new PublicKey(h.owner), "confirmed"))
  );
  owners.forEach((h, i) => {
    const result = balanceResults[i];
    if (result.status === "fulfilled") {
      h.solBalance = result.value / 1e9;
    } else {
      logger.warn(`getBalance failed for holder ${h.owner}:`, result.reason?.message);
      h.solBalance = null;
    }
  });

  return { totalSupply, holders };
}

// ============================================================================
// Pre-call filters
// ============================================================================

async function runPreCallFilters(mint, poolAddress) {
  const reasons = [];
  const details = {};

  // 1 & 2: market cap + 5m volume (GeckoTerminal)
  const marketData = await fetchPoolMarketData(poolAddress);
  if (!marketData || marketData.marketCapUsd == null) {
    reasons.push("market cap unavailable");
  } else {
    details.marketCapUsd = marketData.marketCapUsd;
    if (marketData.marketCapUsd < config.filterMcMin) {
      reasons.push(`market cap $${marketData.marketCapUsd.toFixed(0)} below floor $${config.filterMcMin}`);
    }
    if (marketData.marketCapUsd > config.filterMcMax) {
      reasons.push(`market cap $${marketData.marketCapUsd.toFixed(0)} above ceiling $${config.filterMcMax}`);
    }
  }

  if (!marketData || marketData.volume5mUsd == null) {
    reasons.push("5m volume unavailable");
  } else {
    details.volume5mUsd = marketData.volume5mUsd;
    if (marketData.volume5mUsd < config.filterMinVolume5m) {
      reasons.push(`5m volume $${marketData.volume5mUsd.toFixed(0)} below floor $${config.filterMinVolume5m}`);
    }
  }

  // 3: Trench bundle / insider check
  const trench = await fetchTrenchBundleData(mint);
  if (!trench) {
    reasons.push("trench bundle data unavailable");
  } else {
    details.bundlePct = trench.bundlePct;
    details.insiderPct = trench.insiderPct;
    if (trench.bundlePct >= config.filterMaxBundlePct) {
      reasons.push(`bundles hold ${trench.bundlePct.toFixed(1)}% of supply (>= ${config.filterMaxBundlePct}%)`);
    }
    if (trench.insiderPct >= config.filterMaxInsiderPct) {
      reasons.push(`insiders hold ${trench.insiderPct.toFixed(1)}% of supply (>= ${config.filterMaxInsiderPct}%)`);
    }
  }

  // 4 & 5: top holder concentration + SOL balances (Helius)
  const holderData = await getTopHolders(mint, config.filterTopHoldersN);
  if (!holderData) {
    reasons.push("holder data unavailable");
  } else {
    const holders = holderData.holders;
    const sortedByPct = [...holders].sort((a, b) => b.pctOfSupply - a.pctOfSupply);
    const top2 = sortedByPct.slice(0, 2);
    details.top2HolderPcts = top2.map((h) => h.pctOfSupply);

    if (top2.length === 2 && top2.every((h) => h.pctOfSupply >= config.filterTop2HolderPct)) {
      reasons.push(
        `top 2 holders both hold >= ${config.filterTop2HolderPct}% (${top2
          .map((h) => h.pctOfSupply.toFixed(1) + "%")
          .join(", ")})`
      );
    }

    const combinedSol = holders.reduce((sum, h) => sum + (h.solBalance || 0), 0);
    const walletsWithMinSol = holders.filter((h) => (h.solBalance || 0) >= config.filterMinWalletSol).length;

    details.combinedTopHolderSol = combinedSol;
    details.walletsWithMinSol = walletsWithMinSol;

    if (combinedSol < config.filterMinCombinedSol) {
      reasons.push(
        `top ${config.filterTopHoldersN} holders combined SOL ${combinedSol.toFixed(2)} below floor ${config.filterMinCombinedSol}`
      );
    }
    if (walletsWithMinSol < config.filterMinWalletsWithSol) {
      reasons.push(
        `only ${walletsWithMinSol} of top ${config.filterTopHoldersN} holders have >= ${config.filterMinWalletSol} SOL (need ${config.filterMinWalletsWithSol})`
      );
    }
  }

  const passed = reasons.length === 0;
  if (!passed) {
    logger.info(`Pre-call filters FAILED for ${mint}: ${reasons.join(" | ")}`);
  } else {
    logger.info(`Pre-call filters PASSED for ${mint}`);
  }

  return { passed, reasons, details };
}

// ============================================================================
// Telegram
// ============================================================================

function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatMultiple(current, base) {
  if (!base || !Number.isFinite(current) || !Number.isFinite(base)) return "n/a";
  return `${(current / base).toFixed(2)}x`;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error(`Telegram send failed (${res.status}): ${body}`);
    }
  } catch (err) {
    logger.error("Telegram send error:", err.message);
  }
}

function formatBuySignal({ mint, symbol, ath, dipLow, currentPrice, poolAddress }) {
  const recoveryPct = (config.recoveryThreshold * 100).toFixed(0);
  return [
    `*BUY SIGNAL${symbol ? `: ${symbol}` : ""}*`,
    `Mint: \`${mint}\``,
    `ATH (last ${config.athCandleCount}m): $${ath}`,
    `Dip low seen: $${dipLow}`,
    `Current price: $${currentPrice} (ATH +${recoveryPct}% recovery)`,
    `Pool: https://www.geckoterminal.com/solana/pools/${poolAddress}`,
  ].join("\n");
}

function formatRugAlert({ mint, entryMC, rugMC, poolAddress }) {
  const dropPct = entryMC ? (((entryMC - rugMC) / entryMC) * 100).toFixed(0) : "?";
  return [
    `*RUG ALERT*`,
    `Mint: \`${mint}\``,
    `Entry MC: ${formatUsd(entryMC)}`,
    `Current MC: ${formatUsd(rugMC)} (-${dropPct}%)`,
    `Pool: https://www.geckoterminal.com/solana/pools/${poolAddress}`,
  ].join("\n");
}

function formatBatchReport(reports) {
  const lines = [`*Post-Call Batch Report (${reports.length} calls)*`, ""];
  reports.forEach((r, i) => {
    const peakMultiple = formatMultiple(r.peakMC, r.entryMC);
    const mc80Multiple = formatMultiple(r.mcAt80Min, r.entryMC);
    lines.push(
      `${i + 1}. ${r.symbol ? `*${r.symbol}*` : `\`${r.mint.slice(0, 8)}...\``}${r.rugged ? " ⚠️ RUGGED" : ""}`,
      `   Entry MC: ${formatUsd(r.entryMC)}`,
      `   Peak MC: ${formatUsd(r.peakMC)} (${peakMultiple})`,
      `   Pre-peak low MC: ${formatUsd(r.preePeakLowMC)}`,
      `   MC @ 80min: ${formatUsd(r.mcAt80Min)} (${mc80Multiple})`,
      r.rugged ? `   Rug MC: ${formatUsd(r.rugMC)}` : null,
      `   Mint: \`${r.mint}\``,
      ""
    );
  });
  return lines.filter((l) => l !== null).join("\n");
}

// ============================================================================
// Batch report queue
// ============================================================================

let _pendingReports = [];

async function addReportToBatch(report) {
  _pendingReports.push(report);
  logger.info(
    `Queued post-call report for ${report.mint} (${_pendingReports.length}/${config.batchReportSize} until batch send)`
  );
  if (_pendingReports.length >= config.batchReportSize) {
    const batch = _pendingReports.splice(0, config.batchReportSize);
    await sendTelegramMessage(formatBatchReport(batch));
    logger.info(`Sent batch report covering ${batch.length} calls.`);
  }
}

// ============================================================================
// Wallet watcher (Helius WebSocket -> buy detection)
// ============================================================================

function detectBuy(tx, walletAddress) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  const programIds = new Set(
    (tx.transaction.message.instructions || []).map((ix) => ix.programId?.toString()).filter(Boolean)
  );
  for (const inner of tx.meta.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      if (ix.programId) programIds.add(ix.programId.toString());
    }
  }

  const touchesWatchedProgram = [...programIds].some((id) => WATCHED_PROGRAM_IDS.has(id));
  if (!touchesWatchedProgram) return null;

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  for (const postBal of post) {
    if (postBal.owner !== walletAddress) continue;
    if (postBal.mint === SOL_MINT) continue;

    const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex && p.owner === walletAddress);
    const preAmount = Number(preBal?.uiTokenAmount?.uiAmount || 0);
    const postAmount = Number(postBal.uiTokenAmount?.uiAmount || 0);

    if (postAmount > preAmount) {
      return { mint: postBal.mint, amountDelta: postAmount - preAmount };
    }
  }
  return null;
}

function watchWallet(onBuy) {
  const connection = getConnection();
  const walletPubkey = new PublicKey(config.walletAddress);

  logger.info(`Subscribing to logs for wallet ${config.walletAddress}`);

  connection.onLogs(
    walletPubkey,
    async (logInfo) => {
      if (logInfo.err) return;
      const signature = logInfo.signature;
      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        const buy = detectBuy(tx, config.walletAddress);
        if (buy) {
          logger.info(`Detected buy: mint=${buy.mint} sig=${signature}`);
          onBuy({ mint: buy.mint, signature });
        }
      } catch (err) {
        logger.warn(`Failed to fetch/parse tx ${signature}:`, err.message);
      }
    },
    "confirmed"
  );

  connection.getSlot().then(
    () => logger.info("Helius connection established."),
    (err) => logger.error("Failed to reach Helius RPC:", err.message)
  );
}

// ============================================================================
// Token tracker (dip/recovery pre-call, then post-call, then reset & repeat)
// ============================================================================

const Status = {
  INIT: "init",
  WAITING_FOR_DIP: "waiting_for_dip",
  ARMED: "armed",
  POST_CALL: "post_call",
  DONE: "done",
};

class TokenTracker {
  constructor(mint, onDone) {
    this.mint = mint;
    this.status = Status.INIT;
    this.poolAddress = null;
    this.ath = null;
    this.dipLow = null;
    this.recentPrices = [];
    this.pollTimer = null;
    this.onDone = onDone || (() => {});
    this._firing = false;

    this.candlePollTimer = null;
    this.entryMC = null;
    this.entryPriceLive = null;
    this.entryTimestamp = null;
    this.postCallPeakMC = null;
    this.postCallPeakPrice = null;
    this.postCallPreePeakLowMC = null;
    this.postCallRunningMinLowMC = null;
    this.postCallMcAt80 = null;
    this.postCallRugged = false;
    this.postCallRugMC = null;
    this.postCallRugTimestamp = null;
    this.postCallLastCandleTs = 0;
    this.symbol = null;
  }

  async start() {
    const pool = await findPoolForToken(this.mint);
    if (!pool) {
      logger.warn(`No pool found for ${this.mint}; abandoning tracker.`);
      this.stop();
      return;
    }
    this.poolAddress = pool.poolAddress;

    const ath = await fetchAthFromCandles(this.poolAddress, config.athCandleCount);
    if (!ath) {
      logger.warn(`Could not compute ATH for ${this.mint}; abandoning tracker.`);
      this.stop();
      return;
    }
    this.ath = ath;
    this.status = Status.WAITING_FOR_DIP;
    logger.info(`Tracking ${this.mint} | pool=${this.poolAddress} | ATH(last ${config.athCandleCount}m)=$${ath}`);

    this._startDipRecoveryPolling();
  }

  _startDipRecoveryPolling() {
    this.pollTimer = setInterval(() => this._poll(), config.pricePollIntervalMs);
    this._poll();
  }

  _stopDipRecoveryPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  stop() {
    this._stopDipRecoveryPolling();
    if (this.candlePollTimer) clearInterval(this.candlePollTimer);
    this.candlePollTimer = null;
    this.status = Status.DONE;
    this.onDone(this.mint);
  }

  async _poll() {
    if (this.status === Status.DONE) {
      this.stop();
      return;
    }
    const price = await fetchPoolPrice(this.poolAddress);
    if (price == null) return;

    this._trackRecentPrices(price);

    if (this.status === Status.WAITING_FOR_DIP) {
      this._checkForDip(price);
    } else if (this.status === Status.ARMED) {
      this._checkForRecovery(price);
    }
  }

  _trackRecentPrices(price) {
    this.recentPrices.push(price);
    const maxLen = config.recoveryTicksRequired + 1;
    if (this.recentPrices.length > maxLen) this.recentPrices.shift();
  }

  _isRecovering() {
    const needed = config.recoveryTicksRequired;
    if (this.recentPrices.length < needed + 1) return false;
    const window = this.recentPrices.slice(-(needed + 1));
    for (let i = 1; i < window.length; i++) {
      if (window[i] <= window[i - 1]) return false;
    }
    return true;
  }

  _checkForDip(price) {
    const dipTriggerPrice = this.ath * (1 - config.dipThreshold);
    if (price <= dipTriggerPrice) {
      this.dipLow = this.dipLow == null ? price : Math.min(this.dipLow, price);
      if (this._isRecovering()) {
        this.status = Status.ARMED;
        logger.info(`${this.mint} ARMED — dipped to $${this.dipLow} (<=${dipTriggerPrice.toFixed(10)}) and recovering.`);
      }
    }
  }

  _checkForRecovery(price) {
    if (this._firing) return;
    if (this.dipLow == null || price < this.dipLow) this.dipLow = price;

    const recoveryTargetPrice = this.ath * (1 + config.recoveryThreshold);
    if (price >= recoveryTargetPrice) {
      this._firing = true;
      this._fireSignal(price);
    }
  }

  async _fireSignal(price) {
    logger.info(
      `${this.mint} recovered to $${price} (>= ATH +${config.recoveryThreshold * 100}%). Running pre-call filters.`
    );

    const filterResult = await runPreCallFilters(this.mint, this.poolAddress);
    if (!filterResult.passed) {
      logger.info(`${this.mint} blocked by pre-call filters; no signal sent.`);
      this.stop();
      return;
    }

    const text = formatBuySignal({
      mint: this.mint,
      ath: this.ath,
      dipLow: this.dipLow,
      currentPrice: price,
      poolAddress: this.poolAddress,
    });
    await sendTelegramMessage(text);

    await this._startPostCall();
  }

  async _startPostCall() {
    const entry = await fetchPairMarketData(this.poolAddress);
    if (!entry) {
      logger.warn(`${this.mint}: couldn't get a live DexScreener entry snapshot; skipping post-call tracking.`);
      this.stop();
      return;
    }

    this._stopDipRecoveryPolling();
    this._firing = false;

    this.symbol = entry.symbol;
    this.entryMC = entry.marketCapUsd;
    this.entryPriceLive = entry.priceUsd;
    this.entryTimestamp = Date.now();

    this.postCallPeakMC = this.entryMC;
    this.postCallPeakPrice = this.entryPriceLive;
    this.postCallPreePeakLowMC = this.entryMC;
    this.postCallRunningMinLowMC = this.entryMC;
    this.postCallMcAt80 = null;
    this.postCallRugged = false;
    this.postCallRugMC = null;
    this.postCallRugTimestamp = null;
    this.postCallLastCandleTs = 0;

    this.status = Status.POST_CALL;
    logger.info(
      `${this.mint} entering post-call tracking | entry MC=${this.entryMC.toFixed(0)} | window=${config.postCallDurationMinutes}min`
    );

    this.candlePollTimer = setInterval(() => this._postCallPoll(), config.candlePollIntervalMs);
    this._postCallPoll();
  }

  async _postCallPoll() {
    if (this.status !== Status.POST_CALL) {
      if (this.candlePollTimer) clearInterval(this.candlePollTimer);
      return;
    }

    const elapsedMs = Date.now() - this.entryTimestamp;

    const live = await fetchPairMarketData(this.poolAddress);
    const liveRatio = live ? live.marketCapUsd / live.priceUsd : null;

    if (liveRatio) {
      const candles = await fetchRecentCandles(this.poolAddress, config.postCallCandleLookback);
      for (const c of candles || []) {
        if (c.timestamp <= this.postCallLastCandleTs) continue;

        const highMC = c.high * liveRatio;
        const lowMC = c.low * liveRatio;

        if (this.postCallRunningMinLowMC == null || lowMC < this.postCallRunningMinLowMC) {
          this.postCallRunningMinLowMC = lowMC;
        }

        if (highMC > this.postCallPeakMC) {
          this.postCallPreePeakLowMC = this.postCallRunningMinLowMC;
          this.postCallPeakMC = highMC;
          this.postCallPeakPrice = c.high;
        }

        if (!this.postCallRugged && this.entryMC > 0 && lowMC <= this.entryMC * (1 - config.rugDropPct)) {
          this.postCallRugged = true;
          this.postCallRugMC = lowMC;
          this.postCallRugTimestamp = Date.now();
          logger.warn(`${this.mint} RUG detected — MC ${lowMC.toFixed(0)} vs entry ${this.entryMC.toFixed(0)}`);
          await sendTelegramMessage(
            formatRugAlert({ mint: this.mint, entryMC: this.entryMC, rugMC: lowMC, poolAddress: this.poolAddress })
          );
        }

        this.postCallLastCandleTs = c.timestamp;
      }
    }

    if (elapsedMs >= config.postCallDurationMinutes * 60 * 1000) {
      await this._finalizePostCall(live);
    }
  }

  async _finalizePostCall(liveAt80) {
    if (this.candlePollTimer) clearInterval(this.candlePollTimer);
    this.candlePollTimer = null;

    this.postCallMcAt80 = liveAt80 ? liveAt80.marketCapUsd : this.postCallPeakMC;

    const report = {
      mint: this.mint,
      symbol: this.symbol,
      poolAddress: this.poolAddress,
      entryMC: this.entryMC,
      entryTimestamp: this.entryTimestamp,
      peakMC: this.postCallPeakMC,
      preePeakLowMC: this.postCallPreePeakLowMC,
      mcAt80Min: this.postCallMcAt80,
      rugged: this.postCallRugged,
      rugMC: this.postCallRugMC,
      rugTimestamp: this.postCallRugTimestamp,
    };

    await addReportToBatch(report);

    logger.info(
      `${this.mint} post-call window complete — resetting with peak ($${this.postCallPeakPrice}) as new ATH to watch for a second call.`
    );

    this.ath = this.postCallPeakPrice || this.entryPriceLive;
    this.dipLow = null;
    this.recentPrices = [];
    this.status = Status.WAITING_FOR_DIP;
    this._startDipRecoveryPolling();
  }
}

class TokenTrackerManager {
  constructor() {
    this.trackers = new Map();
  }

  async handleBuy(mint) {
    if (this.trackers.has(mint)) {
      logger.info(`Already tracking ${mint}; ignoring duplicate buy event.`);
      return;
    }
    const tracker = new TokenTracker(mint, (doneMint) => this.trackers.delete(doneMint));
    this.trackers.set(mint, tracker);
    await tracker.start();
  }
}

// ============================================================================
// Entry point
// ============================================================================

function main() {
  logger.info("Starting Solana copy-trade signal bot");
  logger.info(`Watching wallet: ${config.walletAddress}`);
  logger.info(
    `Params: ATH window=${config.athCandleCount}m | dip=${config.dipThreshold * 100}% | ` +
      `recovery=${config.recoveryThreshold * 100}% | poll=${config.pricePollIntervalMs}ms`
  );

  const manager = new TokenTrackerManager();

  watchWallet(({ mint, signature }) => {
    logger.info(`New buy event mint=${mint} sig=${signature} -> starting tracker`);
    manager.handleBuy(mint).catch((err) => logger.error(`Tracker error for ${mint}:`, err.message));
  });

  process.on("SIGINT", () => {
    logger.info("Shutting down.");
    process.exit(0);
  });
}

main();
