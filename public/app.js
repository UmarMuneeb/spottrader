const params = new URLSearchParams(window.location.search);
const queryBackend = params.get('backend');

const API_BASE = queryBackend 
  ? queryBackend.replace(/\/$/, '')
  : (!window.location.hostname.endsWith('vercel.app')
      ? window.location.origin
      : 'http://178.128.150.200:3001');
let currentSymbol = 'SOL/USDT';
let equityChart = null;
let paperInitialBalance = 1000.0;
let activeSymbols = [];
let lastSymbolsHash = '';
let isSettingsLoaded = false;  // Only populate settings inputs once per session

const priceHistory = {};

// Render ticker cards dynamically
function renderTickers(symbols) {
  const container = document.getElementById('tickers-wrapper');
  if (!container) return;
  container.innerHTML = symbols.map((symbol, idx) => {
    const key = symbol.split('/')[0];
    const activeClass = symbol === currentSymbol ? 'active' : '';
    
    // Retrieve last price from history if exists
    const history = priceHistory[symbol] || [];
    const lastPrice = history.length > 0 ? history[history.length - 1] : 0.0;
    const priceText = lastPrice > 0 ? `$${lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00';
    
    const openPrice = history[0] || lastPrice;
    const pctChange = lastPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0.0;
    const changeText = `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`;
    const changeClass = `change ${pctChange >= 0 ? 'positive' : 'negative'}`;

    return `
      <div class="ticker-card glass-card ${activeClass}" onclick="selectSymbol('${symbol}')" id="ticker-${key}">
        <div class="glow-border"></div>
        <div class="ticker-info">
          <span class="ticker-symbol">${symbol}</span>
          <span class="ticker-price" id="${key.toLowerCase()}-price">${priceText}</span>
        </div>
        <div class="ticker-stats">
          <span class="${changeClass}" id="${key.toLowerCase()}-change">${changeText}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Render manual trade symbol dropdown options dynamically
function renderManualTradeSelect(symbols) {
  const select = document.getElementById('manual-symbol');
  if (!select) return;
  select.innerHTML = symbols.map(symbol => `
    <option value="${symbol}">${symbol}</option>
  `).join('');
}

// Initialize Chart.js
function initEquityChart(initialData = []) {
  // Check if a Chart instance already exists on this canvas
  const existingChart = Chart.getChart('equityChart');
  if (existingChart) {
    equityChart = existingChart;
    return;
  }
  
  if (equityChart !== null) {
    return; // Already initialized in memory, prevent Chart.js reuse exception
  }
  
  const canvas = document.getElementById('equityChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Format labels (timestamps to local time) and data points
  let labels = initialData.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  let dataPoints = initialData.map(d => d.balance);

  if (labels.length === 0) {
    labels = [new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })];
    dataPoints = [1000.0];
  }

  // Create gradient fill for equity curve
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(6, 182, 212, 0.3)');
  gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Equity (USDT)',
        data: dataPoints,
        borderColor: '#06b6d4',
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { size: 9 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#64748b', font: { size: 9 } }
        }
      }
    }
  });
}

// Render Regime Win Rate stats in Sidebar
function updateRegimeStatsUI(stats) {
  const defaults = {
    TRENDING: { wins: 0, total: 0 },
    RANGING: { wins: 0, total: 0 },
    VOLATILE: { wins: 0, total: 0 },
    NEUTRAL: { wins: 0, total: 0 }
  };

  stats.forEach(s => {
    const rKey = (s.regime || 'NEUTRAL').toUpperCase();
    if (defaults[rKey]) {
      defaults[rKey].wins = s.winningTrades;
      defaults[rKey].total = s.totalTrades;
    }
  });

  const renderItem = (regimeKey, elementId) => {
    const el = document.getElementById(elementId);
    if (!el) return;
    const r = defaults[regimeKey];
    if (r.total === 0) {
      el.innerText = `0.0% (0 trades)`;
    } else {
      const wr = (r.wins / r.total) * 100;
      el.innerText = `${wr.toFixed(1)}% (${r.total} trades)`;
    }
  };

  renderItem('TRENDING', 'regime-winrate-trending');
  renderItem('RANGING', 'regime-winrate-ranging');
  renderItem('VOLATILE', 'regime-winrate-volatile');
  renderItem('NEUTRAL', 'regime-winrate-neutral');
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function encodeSymbol(symbol) {
  const isModal = API_BASE.includes('modal.run');
  const encoded = encodeURIComponent(symbol);
  return isModal ? encodeURIComponent(encoded) : encoded;
}

function updateTickerPrice(symbol, price) {
  if (!priceHistory[symbol]) {
    priceHistory[symbol] = [];
  }

  const key = symbol.split('/')[0];
  const priceEl = document.getElementById(`${key.toLowerCase()}-price`);
  const changeEl = document.getElementById(`${key.toLowerCase()}-change`);

  if (!priceEl || !changeEl) return;

  const oldPrice = parseFloat(priceEl.innerText.replace('$', '').replace(',', '')) || 0;

  if (price > oldPrice) {
    priceEl.style.color = 'var(--color-green)';
    setTimeout(() => { if (priceEl) priceEl.style.color = '#fff'; }, 300);
  } else if (price < oldPrice) {
    priceEl.style.color = 'var(--color-red)';
    setTimeout(() => { if (priceEl) priceEl.style.color = '#fff'; }, 300);
  }

  priceEl.innerText = `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const history = priceHistory[symbol];
  history.push(price);
  if (history.length > 50) history.shift();
  const openPrice = history[0] || price;
  const pctChange = ((price - openPrice) / openPrice) * 100;

  changeEl.innerText = `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`;
  changeEl.className = `change ${pctChange >= 0 ? 'positive' : 'negative'}`;
}

async function fetchSymbolPrices() {
  if (!activeSymbols || activeSymbols.length === 0) return;

  const requests = activeSymbols.map(async (symbol) => {
    try {
      const res = await fetch(apiUrl(`/api/candles/${encodeSymbol(symbol)}`));
      if (!res.ok) return;
      const candles = await res.json();
      if (!Array.isArray(candles) || candles.length === 0) return;
      const last = candles[candles.length - 1];
      if (last && typeof last.close === 'number') {
        updateTickerPrice(symbol, last.close);
      }
    } catch (err) {
      // Ignore per-symbol errors
    }
  });

  await Promise.all(requests);
}

async function fetchInspectorData() {
  if (!currentSymbol) return;
  try {
    const res = await fetch(apiUrl(`/api/inspect/${encodeSymbol(currentSymbol)}`));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.symbol) return;
    applyTickData(data);
  } catch (err) {
    // Ignore errors; polling will try again
  }
}

async function fetchInitialData() {
  try {
    // 1. Fetch system status
    const statusRes = await fetch(apiUrl('/api/status'));
    const status = await statusRes.json();

    paperInitialBalance = status.paperInitialBalance || 1000.0;
    activeSymbols = status.symbols || [];

    if (!activeSymbols.includes(currentSymbol) && activeSymbols.length > 0) {
      currentSymbol = activeSymbols[0];
      const inspectedSymbolEl = document.getElementById('inspected-symbol');
      if (inspectedSymbolEl) {
        inspectedSymbolEl.innerText = currentSymbol;
      }
    }

    // Initialize priceHistory keys for active symbols if not set
    activeSymbols.forEach(symbol => {
      if (!priceHistory[symbol]) {
        priceHistory[symbol] = [];
      }
    });

    // Check if symbols changed, and re-render if necessary
    const symbolsHash = JSON.stringify(activeSymbols);
    if (symbolsHash !== lastSymbolsHash) {
      renderTickers(activeSymbols);
      renderManualTradeSelect(activeSymbols);
      lastSymbolsHash = symbolsHash;
    }

    document.getElementById('trade-mode').innerText = status.tradingMode.toUpperCase();

    // Populate settings inputs only once per session (avoid overwriting in-progress user edits)
    if (!isSettingsLoaded) {
      document.getElementById('setting-mode').value = status.tradingMode;
      document.getElementById('setting-anomaly').value = status.enableAnomalyFilter ? "true" : "false";

      // Exposure slider: API returns a decimal (e.g. 0.3), slider uses percentage (e.g. 30)
      if (status.exposureLimitPct !== undefined) {
        const exposurePct = Math.round(status.exposureLimitPct * 100);
        document.getElementById('setting-exposure').value = exposurePct;
        document.getElementById('val-exposure').innerText = exposurePct + '%';
      }

      // Voting threshold slider
      if (status.votingThreshold !== undefined) {
        document.getElementById('setting-threshold').value = status.votingThreshold;
        document.getElementById('val-threshold').innerText = parseFloat(status.votingThreshold).toFixed(1);
      }

      // Cooldown slider
      if (status.cooldownMinutes !== undefined) {
        document.getElementById('setting-cooldown').value = status.cooldownMinutes;
        document.getElementById('val-cooldown').innerText = status.cooldownMinutes + 'm';
      }

      isSettingsLoaded = true;
    }
    
    // Check if live API is connected
    const botStatusEl = document.getElementById('bot-status');
    if (status.isTradingEnabled) {
      botStatusEl.innerHTML = `<span class="pulse-dot green"></span><span class="status-text">SYSTEM ONLINE ${status.mlConnected ? '(ML CONNECTED)' : '(ML STANDBY)'}</span>`;
      botStatusEl.className = 'status-badge';
    } else {
      botStatusEl.innerHTML = `<span class="pulse-dot red"></span><span class="status-text">CIRCUIT BREAKER LOCKOUT</span>`;
      botStatusEl.className = 'status-badge bg-red';
    }

    updatePortfolioUI(status.portfolio);

    // 2. Fetch trade history
    const tradesRes = await fetch(apiUrl('/api/trades'));
    const trades = await tradesRes.json();
    renderTradesTable(trades);
    renderActivePositions(trades);
    calculateWinRate(trades);

    // 3. Fetch audit logs
    const logsRes = await fetch(apiUrl('/api/logs'));
    const logs = await logsRes.json();
    renderLogsConsole(logs);

    // 4. Initialize dummy balance history chart or fetch if available
    initEquityChart([]);

    // 5. Update Regime Statistics
    if (status.regimeStats) {
      updateRegimeStatsUI(status.regimeStats);
    }

  } catch (err) {
    console.error('Failed to load initial metrics:', err);
    appendConsoleLine('ERROR', 'SYSTEM', `Failed to contact API server: ${err.message}`);
  }
}

// Update settings via POST request
async function updateSettings(event) {
  event.preventDefault();
  const tradingMode = document.getElementById('setting-mode').value;
  const exposureLimitPct = parseFloat(document.getElementById('setting-exposure').value) / 100;
  const votingThreshold = parseFloat(document.getElementById('setting-threshold').value);
  const cooldownMinutes = parseInt(document.getElementById('setting-cooldown').value, 10);
  const enableAnomalyFilter = document.getElementById('setting-anomaly').value === "true";

  try {
    const res = await fetch(apiUrl('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradingMode, exposureLimitPct, votingThreshold, cooldownMinutes, enableAnomalyFilter })
    });
    const result = await res.json();
    if (result.success) {
      appendConsoleLine('SUCCESS', 'SYSTEM', `Engine configurations updated successfully.`);
      document.getElementById('trade-mode').innerText = tradingMode.toUpperCase();
      isSettingsLoaded = false;  // Allow sliders to re-populate from confirmed server values
      await fetchInitialData();
    }
  } catch (err) {
    appendConsoleLine('ERROR', 'SYSTEM', `Failed updating settings: ${err.message}`);
  }
}

// Trigger Manual Order
async function placeManualTrade(direction) {
  const symbol = document.getElementById('manual-symbol').value;
  appendConsoleLine('INFO', 'EXECUTION', `Force manual ${direction} order triggered for ${symbol}...`);
  try {
    const res = await fetch(apiUrl('/api/manual-trade'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction })
    });
    const result = await res.json();
    if (result.success) {
      appendConsoleLine('SUCCESS', 'EXECUTION', `Manual ${direction} trade executed.`);
      fetchInitialData(); // reload
    } else {
      appendConsoleLine('WARNING', 'EXECUTION', `Manual order rejected: ${result.message}`);
    }
  } catch (err) {
    appendConsoleLine('ERROR', 'EXECUTION', `Failed manual trade: ${err.message}`);
  }
}

// Trigger Emergency Halt (Circuit Breaker Override)
async function triggerEmergencyStop() {
  if (confirm("Are you sure you want to HALT the trading engine and LIQUIDATE all open positions immediately?")) {
    appendConsoleLine('CAUTION', 'SYSTEM', 'EMERGENCY STOP PRESSED! Liquidating positions...');
    try {
      // Force disable trading mode and close positions
      await fetch(apiUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingMode: 'paper', exposureLimitPct: 0 })
      });
      
      // Loop over active symbols to liquidate them dynamically
      for (const symbol of activeSymbols) {
        await fetch(apiUrl('/api/manual-trade'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, direction: 'SELL' })
        });
      }

      appendConsoleLine('CAUTION', 'SYSTEM', 'All open positions liquidated. Bot halted.');
      fetchInitialData();
    } catch (err) {
      appendConsoleLine('ERROR', 'SYSTEM', `Halt failed: ${err.message}`);
    }
  }
}

// Select Monitored Symbol on Tickers Click
function selectSymbol(symbol) {
  currentSymbol = symbol;
  
  // Update Ticker highlight classes
  document.querySelectorAll('.ticker-card').forEach(card => card.classList.remove('active'));
  
  const key = symbol.split('/')[0];
  const cardEl = document.getElementById(`ticker-${key}`);
  if (cardEl) {
    cardEl.classList.add('active');
  }
  const inspectedSymbolEl = document.getElementById('inspected-symbol');
  if (inspectedSymbolEl) {
    inspectedSymbolEl.innerText = symbol;
  }
  
  appendConsoleLine('INFO', 'SYSTEM', `Dashboard focus switched to ${symbol}`);
}

// Calculate win rate from trade history (last 30 trades)
function calculateWinRate(trades) {
  if (!Array.isArray(trades)) {
    document.getElementById('metric-winrate').innerText = '0.0%';
    return;
  }
  const closed = trades.filter(t => t.status === 'CLOSED');
  if (closed.length === 0) {
    document.getElementById('metric-winrate').innerText = '0.0%';
    return;
  }
  const slice = closed.slice(0, 30);
  const wins = slice.filter(t => t.pnl > 0).length;
  const winRate = (wins / slice.length) * 100;
  document.getElementById('metric-winrate').innerText = `${winRate.toFixed(1)}%`;
}

// Render open positions in DOM
function renderActivePositions(trades) {
  const container = document.getElementById('positions-container');
  if (!Array.isArray(trades)) {
    container.innerHTML = `<div class="empty-state">No open positions. Ingestion actively scanning...</div>`;
    document.getElementById('metric-exposure').innerText = '0%';
    return;
  }
  const open = trades.filter(t => t.status === 'OPEN');
  
  if (open.length === 0) {
    container.innerHTML = `<div class="empty-state">No open positions. Ingestion actively scanning...</div>`;
    document.getElementById('metric-exposure').innerText = '0%';
    return;
  }

  // Calculate exposure %
  let totalCost = open.reduce((acc, t) => acc + t.usdt_amount, 0);
  // Get portfolio balance
  const balanceTotalText = document.getElementById('balance-total').innerText.replace('$', '').replace(' USDT', '');
  const balance = parseFloat(balanceTotalText) || 1000.0;
  const exposurePct = (totalCost / balance) * 100;
  document.getElementById('metric-exposure').innerText = `${exposurePct.toFixed(0)}%`;

  container.innerHTML = open.map(pos => `
    <div class="position-row">
      <div class="position-header-row">
        <span class="pos-sym">${pos.symbol}</span>
        <span class="badge bg-green">OPEN BUY</span>
      </div>
      <div class="position-details-row">
        <div>
          <span class="pos-lbl">Entry Price</span>
          <span class="pos-val">$${pos.price.toFixed(2)}</span>
        </div>
        <div>
          <span class="pos-lbl">Stop Loss</span>
          <span class="pos-val" style="color: var(--color-red)">$${pos.stop_loss.toFixed(2)}</span>
        </div>
        <div>
          <span class="pos-lbl">Take Profit</span>
          <span class="pos-val" style="color: var(--color-green)">$${pos.take_profit.toFixed(2)}</span>
        </div>
      </div>
      <div class="position-details-row" style="margin-top: 8px;">
        <div>
          <span class="pos-lbl">Total Value</span>
          <span class="pos-val">$${pos.usdt_amount.toFixed(2)}</span>
        </div>
        <div>
          <span class="pos-lbl">Size Qty</span>
          <span class="pos-val">${pos.quantity.toFixed(4)}</span>
        </div>
        <div>
          <span class="pos-lbl">Opened</span>
          <span class="pos-val">${new Date(pos.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// Render closed trades table
function renderTradesTable(trades) {
  const tbody = document.getElementById('trades-table-body');
  if (!Array.isArray(trades)) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center">Awaiting execution data...</td></tr>`;
    return;
  }
  const closed = trades.filter(t => t.status === 'CLOSED');
  
  if (closed.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center">Awaiting execution data...</td></tr>`;
    return;
  }

  tbody.innerHTML = closed.slice(0, 10).map(t => {
    const pnlClass = t.pnl >= 0 ? 'pnl-green' : 'pnl-red';
    const sign = t.pnl >= 0 ? '+' : '';
    return `
      <tr>
        <td><strong>${t.symbol}</strong></td>
        <td><span class="badge ${t.pnl >= 0 ? 'bg-green' : 'bg-red'}">CLOSED</span></td>
        <td>$${t.exit_price ? t.exit_price.toFixed(2) : '0.00'}</td>
        <td class="${pnlClass}">${sign}$${t.pnl.toFixed(2)}</td>
      </tr>
    `;
  }).join('');
}

// Render logs into console
function renderLogsConsole(logs) {
  const container = document.getElementById('console-logs');
  if (!Array.isArray(logs) || logs.length === 0) return;
  
  container.innerHTML = logs.reverse().map(l => {
    const levelClass = l.level.toLowerCase(); // info, warning, error, success
    const dateStr = new Date(l.timestamp).toLocaleTimeString([], { hour12: false });
    return `<div class="log-line ${levelClass}">[${dateStr}] [${l.category}] ${l.message}</div>`;
  }).join('');
  
  container.scrollTop = container.scrollHeight; // Auto scroll
}

// Append live log line in real-time
function appendConsoleLine(level, category, message) {
  const container = document.getElementById('console-logs');
  const levelClass = level.toLowerCase();
  const dateStr = new Date().toLocaleTimeString([], { hour12: false });
  
  const div = document.createElement('div');
  div.className = `log-line ${levelClass}`;
  div.innerText = `[${dateStr}] [${category}] ${message}`;
  
  container.appendChild(div);
  
  // cap logs length in DOM
  if (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
  container.scrollTop = container.scrollHeight;
}

// Update portfolio metrics UI
function updatePortfolioUI(p) {
  document.getElementById('balance-total').innerHTML = `$${p.totalBalance.toFixed(2)} <span class="currency">USDT</span>`;
  document.getElementById('balance-cash').innerText = `$${p.cash.toFixed(2)}`;
  document.getElementById('balance-open').innerText = `$${p.openValue.toFixed(2)}`;
  
  const unrealizedEl = document.getElementById('pnl-unrealized');
  const sign = p.unrealizedPnl >= 0 ? '+' : '';
  unrealizedEl.innerText = `${sign}$${p.unrealizedPnl.toFixed(2)}`;
  unrealizedEl.className = p.unrealizedPnl >= 0 ? 'val pnl-green' : 'val pnl-red';

  // Calculate daily drawdown percentage metric
  // Compare totalBalance against config initial balance (if below, show drawdown)
  const drawdown = Math.max(0.0, ((paperInitialBalance - p.totalBalance) / paperInitialBalance) * 100);
  document.getElementById('metric-drawdown').innerText = `${drawdown.toFixed(1)}%`;
  
  const drawdownBox = document.getElementById('metric-drawdown').parentElement;
  if (drawdown >= 3.0) {
    drawdownBox.classList.add('bg-red');
  } else {
    drawdownBox.classList.remove('bg-red');
  }

  // Toggle live minimum warning banner
  const warningBanner = document.getElementById('live-warning-banner');
  const warningText = document.getElementById('live-warning-text');
  const tradeModeEl = document.getElementById('trade-mode');
  
  if (warningBanner && warningText && tradeModeEl) {
    const tradingModeText = tradeModeEl.innerText.toLowerCase();
    const isLiveOrTestnet = tradingModeText.includes('live') || tradingModeText.includes('testnet');
    if (isLiveOrTestnet && p.totalBalance < 10.00) {
      warningText.innerText = `WARNING: Trading mode is set to ${tradingModeText.toUpperCase()} but portfolio balance ($${p.totalBalance.toFixed(2)}) is below the Binance minimum required limit ($10.00 USDT). Execution will fail!`;
      warningBanner.classList.remove('hidden');
    } else {
      warningBanner.classList.add('hidden');
    }
  }
}

function applyTickData(data) {
  const { symbol, price, indicators, confirmation, mlPredictions, portfolio, trades, logs } = data;
  
  // 1. Update rolling price history and animate ticker price
  updateTickerPrice(symbol, price);

  // 2. Update general portfolio metrics
  updatePortfolioUI(portfolio);

  // 3. Update trades & logs
  renderTradesTable(trades);
  renderActivePositions(trades);
  calculateWinRate(trades);
  renderLogsConsole(logs);

  // 4. Update Equity Chart
  if (equityChart) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    equityChart.data.labels.push(timestamp);
    equityChart.data.datasets[0].data.push(portfolio.totalBalance);
    
    // limit chart points
    if (equityChart.data.labels.length > 30) {
      equityChart.data.labels.shift();
      equityChart.data.datasets[0].data.shift();
    }
    equityChart.update();
  }

  // 5. Update ML inspector & confirmation voting for current inspected symbol
  if (symbol === currentSymbol) {
    // Update regime badge
    const regimeEl = document.getElementById('current-regime');
    if (regimeEl && confirmation.regime) {
      regimeEl.innerText = confirmation.regime.toUpperCase();
      regimeEl.className = 'badge';
      if (confirmation.regime === 'TRENDING') {
        regimeEl.classList.add('bg-green');
      } else if (confirmation.regime === 'RANGING') {
        regimeEl.classList.add('bg-blue');
      } else if (confirmation.regime === 'VOLATILE') {
        regimeEl.classList.add('bg-red');
      } else {
        regimeEl.classList.add('bg-blue');
      }
    }
    // A. ML Scores
    // Random Forest
    const rfVoteText = mlPredictions.rf_vote === 1 ? 'BUY' : (mlPredictions.rf_vote === -1 ? 'SELL' : 'HOLD');
    document.getElementById('rf-status').innerText = `${rfVoteText} (${(mlPredictions.rf_confidence * 100).toFixed(0)}%)`;
    document.getElementById('rf-progress').style.width = `${mlPredictions.rf_confidence * 100}%`;
    document.getElementById('rf-status').style.color = mlPredictions.rf_vote === 1 ? 'var(--color-green)' : (mlPredictions.rf_vote === -1 ? 'var(--color-red)' : 'var(--color-text-secondary)');
    
    // LSTM
    const lstmVoteText = mlPredictions.lstm_vote === 1 ? 'BUY/UP' : 'SELL/DOWN';
    document.getElementById('lstm-status').innerText = `${lstmVoteText} (${(mlPredictions.lstm_confidence * 100).toFixed(0)}%)`;
    document.getElementById('lstm-progress').style.width = `${mlPredictions.lstm_confidence * 100}%`;
    document.getElementById('lstm-status').style.color = mlPredictions.lstm_vote === 1 ? 'var(--color-green)' : 'var(--color-red)';

    // Anomaly status
    const anomalyEl = document.getElementById('anomaly-indicator');
    const anomalyText = document.getElementById('anomaly-text');
    if (mlPredictions.anomaly === 1) {
      anomalyEl.className = 'anomaly-indicator critical';
      anomalyText.innerText = 'VOLATILITY ANOMALY';
    } else {
      anomalyEl.className = 'anomaly-indicator';
      anomalyText.innerText = 'NORMAL STATUS';
    }

    // B. Vote scores
    document.getElementById('vote-score-val').innerText = confirmation.weightedScore.toFixed(2);
    
    // Set color for total vote score
    const scoreValEl = document.getElementById('vote-score-val');
    if (confirmation.weightedScore >= 3.0) {
      scoreValEl.style.color = 'var(--color-green)';
    } else if (confirmation.weightedScore <= -3.0) {
      scoreValEl.style.color = 'var(--color-red)';
    } else {
      scoreValEl.style.color = 'var(--color-amber)';
    }

    // Update strategies list
    const voteMap = confirmation.votes || {};
    
    const updateVoteStatus = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      const text = val === 1 ? 'BUY' : (val === -1 ? 'SELL' : 'HOLD');
      el.innerText = text;
      el.className = `strategy-vote ${text === 'BUY' ? 'BUY' : (text === 'SELL' ? 'SELL' : 'HOLD')}`;
    };

    updateVoteStatus('v-rsi', voteMap.rsi);
    updateVoteStatus('v-macd', voteMap.macd);
    updateVoteStatus('v-bb', voteMap.bb);
    updateVoteStatus('v-ema', voteMap.ema);
    updateVoteStatus('v-vwap', voteMap.vwap);
    updateVoteStatus('v-rf', voteMap.randomForest);
    updateVoteStatus('v-lstm', voteMap.lstm);
    updateVoteStatus('v-sentiment', voteMap.sentimentVote);

    // Update raw indicator values beneath strategy votes
    if (indicators) {
      const rsiEl = document.getElementById('val-rsi');
      if (rsiEl && typeof indicators.rsi === 'number') {
        rsiEl.innerText = `RSI: ${indicators.rsi.toFixed(2)}`;
      }
      
      const macdEl = document.getElementById('val-macd');
      if (macdEl && typeof indicators.macd === 'number' && typeof indicators.macdHist === 'number') {
        macdEl.innerText = `MACD: ${indicators.macd.toFixed(2)} | Hist: ${indicators.macdHist.toFixed(2)}`;
      }

      const bbEl = document.getElementById('val-bb');
      if (bbEl && typeof indicators.bbLower === 'number' && typeof indicators.bbUpper === 'number') {
        bbEl.innerText = `BB: ${indicators.bbLower.toFixed(2)} - ${indicators.bbUpper.toFixed(2)}`;
      }

      const emaEl = document.getElementById('val-ema');
      if (emaEl && typeof indicators.ema20 === 'number' && typeof indicators.ema50 === 'number') {
        emaEl.innerText = `EMA20: ${indicators.ema20.toFixed(2)} | EMA50: ${indicators.ema50.toFixed(2)}`;
      }

      const vwapEl = document.getElementById('val-vwap');
      if (vwapEl && typeof indicators.vwap === 'number') {
        vwapEl.innerText = `VWAP: ${indicators.vwap.toFixed(2)}`;
      }

      const smaEl = document.getElementById('val-sma');
      if (smaEl && typeof indicators.sma50 === 'number') {
        smaEl.innerText = `SMA-50: ${indicators.sma50.toFixed(2)}`;
      }
    }

    // D. Two-Layer Trend Shield Rendering
    const smaShieldEl = document.getElementById('sma-shield-status');
    if (smaShieldEl && typeof confirmation.sma50 === 'number') {
      const isPass = confirmation.priceAboveSma50;
      const currentPrice = price;
      smaShieldEl.innerHTML = `
        <span class="badge ${isPass ? 'bg-green' : 'bg-red'}">${isPass ? 'PASS' : 'BLOCKED'}</span> 
        Price: $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} 
        vs SMA-50: $${confirmation.sma50.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
      `;
    }

    const btcSoftShieldEl = document.getElementById('btc-soft-shield-status');
    if (btcSoftShieldEl && typeof confirmation.btcDailyClose === 'number' && typeof confirmation.btcDailyEma200 === 'number') {
      const isPass = confirmation.btcAboveDailyEma200;
      btcSoftShieldEl.innerHTML = `
        <span class="badge ${isPass ? 'bg-green' : 'bg-amber'}">${isPass ? 'PASS' : 'PENALTY (0.7x)'}</span> 
        BTC: $${confirmation.btcDailyClose.toLocaleString(undefined, { maximumFractionDigits: 0 })} 
        vs EMA-200: $${confirmation.btcDailyEma200.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      `;
    }

    // C. Sentiment Gate Indicator
    const gateValEl = document.getElementById('sentiment-gate-val');
    const gateStatusEl = document.getElementById('sentiment-gate-status');
    const rollingSent = confirmation.rollingSentiment;

    gateValEl.innerText = rollingSent.toFixed(2);
    document.getElementById('metric-sentiment').innerText = rollingSent.toFixed(2);
    
    // Animate sentiment color
    const sentBox = document.getElementById('metric-sentiment').parentElement;
    if (rollingSent > 0.15) {
      document.getElementById('metric-sentiment').style.color = 'var(--color-green)';
    } else if (rollingSent < -0.15) {
      document.getElementById('metric-sentiment').style.color = 'var(--color-red)';
    } else {
      document.getElementById('metric-sentiment').style.color = 'var(--color-text-secondary)';
    }

    if (rollingSent < -0.3) {
      gateStatusEl.innerHTML = `<span class="badge bg-red">BLOCKED</span> Sentiment: <span id="sentiment-gate-val">${rollingSent.toFixed(2)}</span>`;
    } else {
      gateStatusEl.innerHTML = `<span class="badge bg-green">OPEN</span> Sentiment: <span id="sentiment-gate-val">${rollingSent.toFixed(2)}</span>`;
    }
  }
}

// Load resources on load
window.addEventListener('load', () => {
  fetchInitialData();
  fetchSymbolPrices();
  fetchInspectorData();
  // Poll data feeds periodically to keep frontend aligned
  setInterval(fetchInitialData, 30000);
  setInterval(fetchSymbolPrices, 30000);
  setInterval(fetchInspectorData, 30000);
});
