import './style.css';
import type { AppState, DCAEntry } from './types';
import { loadState, saveState, resetState, isDCADoneToday, todayISO } from './store';
import { fetchPriceData } from './price';
import {
  calcDCAAmountUSD,
  updateAverageCost,
  buildSellOrderSpecs,
  recordDCAEntry,
  replaceSellOrders,
  LAMPORTS_PER_SOL,
  USDC_DECIMALS,
} from './strategy';
import {
  getSwapQuote,
  buildSwapTransaction,
  buildLimitOrderTransaction,
  buildCancelOrdersTransaction,
} from './jupiter';
import {
  connectWallet,
  disconnectWallet,
  signAndSend,
  walletPublicKey,
  isPhantomAvailable,
} from './wallet';

// ─── State ────────────────────────────────────────────────────────────────────

let state: AppState = loadState();
let priceData: Awaited<ReturnType<typeof fetchPriceData>> | null = null;
let isLoading = false;

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtUSD(n: number): string {
  return `$${fmt(n)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmt(n, 1)}%`;
}

function fmtSOL(lamports: number): string {
  return `${fmt(lamports / LAMPORTS_PER_SOL, 4)} SOL`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render(): void {
  const pubkey = walletPublicKey();
  const connected = Boolean(pubkey);
  const dcaDoneToday = isDCADoneToday(state);
  const dcaAmountUSD = priceData ? calcDCAAmountUSD(priceData.change30dPct, state.baseAmountUSD) : state.baseAmountUSD;
  const positionSOL = state.totalSOLBoughtLamports / LAMPORTS_PER_SOL;
  const positionValueUSD = positionSOL * (priceData?.currentUSD ?? state.averageBuyPriceUSD);
  const unrealizedPnl = priceData
    ? positionValueUSD - state.totalUSDCSpentMicro / USDC_DECIMALS
    : 0;
  const unrealizedPnlPct = state.totalUSDCSpentMicro > 0
    ? (unrealizedPnl / (state.totalUSDCSpentMicro / USDC_DECIMALS)) * 100
    : 0;

  document.getElementById('app')!.innerHTML = `
    <div class="app">

      <!-- Header -->
      <header class="header">
        <div class="logo-row">
          <span class="logo">◎</span>
          <span class="title">SOL DCA Bot</span>
        </div>
        <button class="btn-icon" id="btnWallet">
          ${connected
            ? `<span class="addr">${pubkey!.slice(0, 4)}…${pubkey!.slice(-4)}</span> ✕`
            : 'Connecter'}
        </button>
      </header>

      <!-- Price Card -->
      <div class="card ${priceData ? '' : 'loading'}">
        <div class="card-label">COURS SOL</div>
        ${priceData ? `
          <div class="price-big">${fmtUSD(priceData.currentUSD)}</div>
          <div class="badge ${priceData.change30dPct >= 0 ? 'badge-green' : 'badge-red'}">
            ${fmtPct(priceData.change30dPct)} (30j)
          </div>
          <div class="price-hint">
            ${priceData.change30dPct > 20
              ? '⏸ DCA suspendu – hausse > 20%'
              : dcaAmountUSD === state.baseAmountUSD
                ? `DCA normal : ${fmtUSD(dcaAmountUSD)}/jour`
                : `DCA renforcé : ${fmtUSD(dcaAmountUSD)}/jour (baisse ≥ ${priceData.change30dPct <= -20 ? '20' : priceData.change30dPct <= -15 ? '15' : '10'}%)`
            }
          </div>
        ` : '<div class="skeleton"></div>'}
      </div>

      <!-- Position Card -->
      <div class="card">
        <div class="card-label">MA POSITION</div>
        <div class="stat-row">
          <span>SOL accumulé</span>
          <strong>${fmtSOL(state.totalSOLBoughtLamports)}</strong>
        </div>
        <div class="stat-row">
          <span>Total investi</span>
          <strong>${fmtUSD(state.totalUSDCSpentMicro / USDC_DECIMALS)}</strong>
        </div>
        <div class="stat-row">
          <span>Prix moyen d'achat</span>
          <strong>${state.averageBuyPriceUSD > 0 ? fmtUSD(state.averageBuyPriceUSD) : '—'}</strong>
        </div>
        ${priceData && positionSOL > 0 ? `
          <div class="stat-row">
            <span>Valeur actuelle</span>
            <strong>${fmtUSD(positionValueUSD)}</strong>
          </div>
          <div class="stat-row">
            <span>P&L latent</span>
            <strong class="${unrealizedPnl >= 0 ? 'green' : 'red'}">
              ${unrealizedPnl >= 0 ? '+' : ''}${fmtUSD(unrealizedPnl)} (${fmtPct(unrealizedPnlPct)})
            </strong>
          </div>
        ` : ''}
      </div>

      <!-- Sell Orders Card -->
      <div class="card">
        <div class="card-label">ORDRES DE VENTE ACTIFS</div>
        ${state.sellOrders.filter(o => o.status === 'active').length === 0
          ? '<div class="empty">Aucun ordre de vente placé</div>'
          : state.sellOrders.filter(o => o.status === 'active').map(o => `
              <div class="order-row">
                <div>
                  <span class="order-label">+${o.targetPct}% → ${fmtUSD(o.targetPriceUSD)}</span>
                  <span class="order-amount">${fmtSOL(o.solLamports)}</span>
                </div>
                <span class="badge badge-yellow">actif</span>
              </div>
            `).join('')
        }
      </div>

      <!-- DCA Action -->
      <div class="card action-card">
        <div class="card-label">ACTION DCA</div>
        ${!connected ? `
          <p class="hint">Connecte ton wallet Phantom pour commencer.</p>
          <button class="btn btn-primary" id="btnConnect">Connecter Phantom</button>
        ` : dcaAmountUSD === 0 ? `
          <div class="badge badge-red">DCA suspendu — hausse > 20% sur 30j</div>
          <p class="hint">Le bot rachètera dès que le prix corrige.</p>
        ` : dcaDoneToday ? `
          <div class="badge badge-green">✓ DCA exécuté aujourd'hui</div>
          <p class="hint">Prochain achat demain — reviens ou active le rappel.</p>
        ` : `
          <p class="dca-amount">Acheter <strong>${fmtUSD(dcaAmountUSD)}</strong> de SOL maintenant</p>
          <button class="btn btn-primary ${isLoading ? 'loading' : ''}" id="btnDCA" ${isLoading ? 'disabled' : ''}>
            ${isLoading ? 'Transaction en cours…' : `Exécuter le DCA – ${fmtUSD(dcaAmountUSD)}`}
          </button>
        `}
      </div>

      <!-- History -->
      ${state.dcaHistory.length > 0 ? `
        <div class="card">
          <div class="card-label">HISTORIQUE DCA</div>
          ${[...state.dcaHistory].reverse().slice(0, 10).map(h => `
            <div class="hist-row">
              <span class="hist-date">${h.date}</span>
              <span class="hist-details">
                ${fmtUSD(h.amountUSD)} → ${fmtSOL(h.solBoughtLamports)}
                <span class="hist-price">@ ${fmtUSD(h.solPriceUSD)}</span>
              </span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- Settings -->
      <div class="card">
        <div class="card-label">PARAMÈTRES</div>
        <div class="setting-row">
          <label>Montant DCA de base (USD)</label>
          <input type="number" id="inputBase" value="${state.baseAmountUSD}" min="1" max="1000" step="1" />
        </div>
        <div class="setting-row">
          <label>DCA activé</label>
          <input type="checkbox" id="chkEnabled" ${state.dcaEnabled ? 'checked' : ''} />
        </div>
        <button class="btn btn-secondary" id="btnSaveSettings">Enregistrer</button>
        <button class="btn btn-danger" id="btnReset">Réinitialiser tout</button>
      </div>

      <footer class="footer">
        <button class="btn btn-ghost" id="btnRefresh">↻ Actualiser prix</button>
        <span class="footer-note">Orders de vente on-chain via Jupiter • s'exécutent seuls</span>
      </footer>

    </div>
  `;

  // Bind events after render
  bindEvents();
}

function bindEvents(): void {
  const btnWallet = $('btnWallet');
  btnWallet?.addEventListener('click', async () => {
    if (walletPublicKey()) {
      await disconnectWallet();
    } else {
      await handleConnect();
    }
    render();
  });

  $('btnConnect')?.addEventListener('click', async () => {
    await handleConnect();
    render();
  });

  $('btnDCA')?.addEventListener('click', async () => {
    if (!isLoading) await handleDCA();
  });

  $('btnRefresh')?.addEventListener('click', async () => {
    await refreshPrice();
    render();
  });

  $('btnSaveSettings')?.addEventListener('click', () => {
    const base = parseFloat((document.getElementById('inputBase') as HTMLInputElement).value);
    const enabled = (document.getElementById('chkEnabled') as HTMLInputElement).checked;
    if (!isNaN(base) && base > 0) {
      state.baseAmountUSD = base;
      state.dcaEnabled = enabled;
      saveState(state);
    }
    render();
  });

  $('btnReset')?.addEventListener('click', () => {
    if (confirm('Réinitialiser tout l\'historique et la position ? Cette action est irréversible.')) {
      state = resetState();
      render();
    }
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function handleConnect(): Promise<void> {
  try {
    await connectWallet();
  } catch (e) {
    if (!isPhantomAvailable()) {
      alert('Ouvre cette page dans le navigateur intégré de Phantom.');
    } else {
      alert(`Erreur de connexion: ${(e as Error).message}`);
    }
  }
}

async function refreshPrice(): Promise<void> {
  try {
    priceData = await fetchPriceData();
  } catch (e) {
    console.error('Prix non disponible:', e);
  }
}

async function handleDCA(): Promise<void> {
  const pubkey = walletPublicKey();
  if (!pubkey || !priceData) return;

  const dcaAmountUSD = calcDCAAmountUSD(priceData.change30dPct, state.baseAmountUSD);
  if (dcaAmountUSD === 0) return;

  isLoading = true;
  render();

  try {
    // 1. Get swap quote
    const quote = await getSwapQuote(dcaAmountUSD);

    // 2. Build and sign the swap transaction
    const swapTx = await buildSwapTransaction(quote, pubkey);
    const swapSig = await signAndSend(swapTx);
    console.log('Swap tx:', swapSig);

    // 3. Update state with new position
    const usdcSpentMicro = Math.floor(dcaAmountUSD * USDC_DECIMALS);
    const updated = updateAverageCost(state, quote.outAmountLamports, usdcSpentMicro);
    state = { ...state, ...updated };

    // 4. Record DCA in history
    const entry: DCAEntry = {
      date: todayISO(),
      amountUSD: dcaAmountUSD,
      solPriceUSD: quote.priceUSD,
      solBoughtLamports: quote.outAmountLamports,
      txSignature: swapSig,
    };
    state.dcaHistory = recordDCAEntry(state, entry);
    state.lastDCADate = todayISO();
    saveState(state);

    // 5. Cancel existing sell orders
    const activeOrderAccounts = state.sellOrders
      .filter(o => o.status === 'active')
      .map(o => o.accountPubkey)
      .filter(Boolean);

    if (activeOrderAccounts.length > 0) {
      const cancelTx = await buildCancelOrdersTransaction(activeOrderAccounts, pubkey);
      if (cancelTx) {
        await signAndSend(cancelTx).catch(console.warn); // non-blocking
      }
    }

    // 6. Place new sell orders
    const specs = buildSellOrderSpecs(state.totalSOLBoughtLamports, state.averageBuyPriceUSD);
    const placedAccounts: string[] = [];

    for (const spec of specs) {
      try {
        const { tx, orderAccount } = await buildLimitOrderTransaction(spec, pubkey);
        await signAndSend(tx);
        placedAccounts.push(orderAccount);
      } catch (err) {
        console.error(`Ordre de vente +${spec.targetPct}% échoué:`, err);
        placedAccounts.push('');
      }
    }

    // 7. Update sell orders in state
    state.sellOrders = replaceSellOrders(state.sellOrders, specs, placedAccounts);
    saveState(state);

    alert(`✅ DCA exécuté !\n${dcaAmountUSD}$ → ${(quote.outAmountLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL\nPrix moyen : ${fmt(state.averageBuyPriceUSD)} $`);

  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('rejected') && !msg.includes('User rejected')) {
      alert(`Erreur: ${msg}`);
    }
  } finally {
    isLoading = false;
    render();
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  render(); // Initial skeleton render

  // Auto-reconnect if previously connected
  if (window.solana?.publicKey) {
    // Already connected (Phantom in-app browser)
  } else if (window.solana) {
    try {
      await window.solana.connect({ onlyIfTrusted: true });
    } catch {
      // Not previously trusted, skip
    }
  }

  await refreshPrice();
  render();

  // Refresh price every 5 minutes
  setInterval(async () => {
    await refreshPrice();
    render();
  }, 5 * 60 * 1000);
}

boot();
