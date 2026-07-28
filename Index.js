sol-copytrade/
  package.json
  .env.example
  README.md
  src/
    config.js        — loads/validates env vars, known DEX program IDs
    walletWatcher.js  — Helius websocket, buy detection
    geckoterminal.js  — pool lookup, 180x 1m candle ATH, price polling
    tokenTracker.js   — dip/recovery state machine per token
    telegram.js       — signal formatting + sending
    index.js          — wires it together
