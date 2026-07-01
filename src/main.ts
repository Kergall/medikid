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
  fetchOpenOrders,
} from './jupiter';
import { Keypair } from '@solana/web3.js';
import { keypairFromBase58, signAndSendLocal, getWalletSolLamports } from './signer';
import { encryptKey, decryptKey, exportAutoKey, importAutoKey, decryptWithAutoKey } from './crypto';
import {
  saveEncryptedKey, loadEncryptedKey,
  saveAutoKey, loadAutoKey, clearAutoKey,
  saveWalletAddress, loadWalletAddress, saveLastDCADate,
} from './db';

// ─── App state ───────────────────────────────────────────────────────────────

let state: AppState = loadState();
let priceData: Awaited<ReturnType<typeof fetchPriceData>> | null = null;
let isLoading = false;
let activeKeypair: Keypair | null = null;   // loaded once per session
let walletAddress: string | null = null;
let view: 'main' | 'setup' = 'main';
let currentTab: 'tableau' | 'dca' | 'reglages' = 'tableau';

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function fmt(n: number, d = 2): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtUSD = (n: number) => `${fmt(n)} USDC`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n, 1)}%`;
const fmtSOL = (l: number) => `${fmt(l / LAMPORTS_PER_SOL, 4)} SOL`;

function html(strings: TemplateStringsArray, ...vals: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '');
}

function on(id: string, ev: string, fn: EventListener): void {
  document.getElementById(id)?.addEventListener(ev, fn);
}

// ─── Shared calculations ─────────────────────────────────────────────────────

function getCalcs() {
  const dcaAmountUSD = priceData
    ? calcDCAAmountUSD(priceData.change30dPct, state.baseAmountUSD)
    : state.baseAmountUSD;
  const posSOL    = state.totalSOLBoughtLamports / LAMPORTS_PER_SOL;
  const cur       = priceData?.currentUSD ?? 0;
  const posValue  = posSOL * (cur || state.averageBuyPriceUSD);
  const invested  = state.totalUSDCSpentMicro / USDC_DECIMALS;
  const pnl       = posSOL > 0 && cur > 0 ? posValue - invested : 0;
  const pnlPct    = invested > 0 ? (pnl / invested) * 100 : 0;
  const done      = isDCADoneToday(state);
  const paused    = dcaAmountUSD === 0;
  const autoOn    = state.walletMode === 'local' && state.autoExecute;
  return { dcaAmountUSD, posSOL, posValue, invested, pnl, pnlPct, done, paused, autoOn };
}

// ─── Tab: Tableau de bord ────────────────────────────────────────────────────

function renderTabDashboard(): string {
  const { posSOL, posValue, invested, pnl, pnlPct } = getCalcs();
  const cur = priceData?.currentUSD ?? 0;
  const avg = state.averageBuyPriceUSD;
  const activeOrders = state.sellOrders.filter(o => o.status === 'active');
  const filledOrders = state.sellOrders.filter(o => o.status === 'filled');

  // Progress bar for sell orders: how far current price is from avg to target
  function orderProgress(targetPrice: number): number {
    if (!cur || !avg || avg <= 0) return 0;
    const range = targetPrice - avg;
    if (range <= 0) return 0;
    return Math.min(100, Math.max(0, ((cur - avg) / range) * 100));
  }

  return html`
    <!-- Cours + statut DCA -->
    <div class="card price-card">
      <div class="price-row">
        <div>
          <div class="card-label">COURS SOL</div>
          ${priceData
            ? html`<div class="price-big">${fmtUSD(priceData.currentUSD)}</div>`
            : '<div class="skeleton" style="width:120px;height:36px"></div>'}
        </div>
        <div class="price-right">
          ${priceData ? html`
            <div class="badge ${priceData.change30dPct >= 0 ? 'badge-green' : 'badge-red'}">
              ${fmtPct(priceData.change30dPct)} / 30j
            </div>
            <div class="dca-status-pill ${getCalcs().paused ? 'pill-red' : 'pill-purple'}">
              ${getCalcs().paused ? '⏸ DCA suspendu' : `DCA ${fmtUSD(getCalcs().dcaAmountUSD)}/j`}
            </div>
          ` : ''}
        </div>
      </div>
    </div>

    <!-- Grille de stats -->
    <div class="stats-grid">
      <div class="stat-cell">
        <div class="stat-label">Investi</div>
        <div class="stat-value">${fmtUSD(invested)}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Valeur actuelle</div>
        <div class="stat-value">${posSOL > 0 && cur > 0 ? fmtUSD(posValue) : '—'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Prix moyen DCA</div>
        <div class="stat-value">${avg > 0 ? fmtUSD(avg) : '—'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">P&L latent</div>
        <div class="stat-value ${pnl > 0 ? 'green' : pnl < 0 ? 'red' : ''}">
          ${posSOL > 0 && cur > 0
            ? html`${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}<br><span class="stat-sub">${fmtPct(pnlPct)}</span>`
            : '—'}
        </div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">SOL accumulé</div>
        <div class="stat-value">${posSOL > 0 ? fmt(posSOL, 4) : '0'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Nb d'achats</div>
        <div class="stat-value">${state.dcaHistory.length}</div>
      </div>
    </div>

    <!-- Ordres de vente avec barres de progression -->
    <div class="card">
      <div class="card-label-row">
        <span class="card-label">ORDRES DE VENTE</span>
        <span class="label-count">${activeOrders.length} actif${activeOrders.length > 1 ? 's' : ''} • ${filledOrders.length} exécuté${filledOrders.length > 1 ? 's' : ''}</span>
      </div>
      ${activeOrders.length === 0
        ? '<div class="empty">Les ordres apparaîtront après le premier achat DCA</div>'
        : activeOrders.map(o => {
            const prog = orderProgress(o.targetPriceUSD);
            const reached = cur >= o.targetPriceUSD;
            return html`
              <div class="order-block">
                <div class="order-header">
                  <div>
                    <span class="order-target">+${o.targetPct}% → <strong>${fmtUSD(o.targetPriceUSD)}</strong></span>
                    <span class="order-qty">${fmtSOL(o.solLamports)} à vendre</span>
                  </div>
                  <span class="badge ${reached ? 'badge-green' : 'badge-yellow'}">${reached ? '✓ atteint' : 'en attente'}</span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill ${reached ? 'fill-green' : 'fill-purple'}" style="width:${prog}%"></div>
                </div>
                <div class="progress-labels">
                  <span>${avg > 0 ? fmtUSD(avg) : '—'} (prix moy.)</span>
                  <span class="prog-pct">${Math.round(prog)}%</span>
                  <span>${fmtUSD(o.targetPriceUSD)}</span>
                </div>
              </div>`;
          }).join('')
      }
    </div>

    <!-- Historique complet -->
    <div class="card">
      <div class="card-label-row">
        <span class="card-label">HISTORIQUE DES ACHATS</span>
        <span class="label-count">${state.dcaHistory.length} au total</span>
      </div>
      ${state.dcaHistory.length === 0
        ? '<div class="empty">Aucun achat encore</div>'
        : html`
          <div class="hist-table">
            <div class="hist-head">
              <span>Date</span><span>Montant</span><span>SOL acheté</span><span>Prix</span>
            </div>
            ${[...state.dcaHistory].reverse().map(h => html`
              <div class="hist-row2">
                <span class="hist-date">${h.date}</span>
                <span class="hist-usd">${fmtUSD(h.amountUSD)}</span>
                <span class="hist-sol">${fmt(h.solBoughtLamports / LAMPORTS_PER_SOL, 4)}</span>
                <span class="hist-price2">${fmtUSD(h.solPriceUSD)}</span>
              </div>`).join('')}
          </div>`
      }
    </div>`;
}

// ─── Tab: DCA ────────────────────────────────────────────────────────────────

function renderTabDCA(): string {
  const { dcaAmountUSD, done, paused, autoOn } = getCalcs();

  return html`
    <!-- Stratégie DCA -->
    <div class="card">
      <div class="card-label">STRATÉGIE EN COURS</div>
      <div class="strategy-grid">
        <div class="strategy-row ${!priceData || (!paused && getCalcs().dcaAmountUSD === state.baseAmountUSD) ? 'active-strat' : ''}">
          <span>Entre −10% et +20%</span><strong>${fmtUSD(state.baseAmountUSD)}/jour</strong>
        </div>
        <div class="strategy-row ${priceData && !paused && dcaAmountUSD >= 10 && (priceData?.change30dPct ?? 0) <= -10 && (priceData?.change30dPct ?? 0) > -15 ? 'active-strat' : ''}">
          <span>Baisse ≥ −10%</span><strong>${fmtUSD(state.baseAmountUSD)}/jour</strong>
        </div>
        <div class="strategy-row ${priceData && !paused && dcaAmountUSD === 15 ? 'active-strat' : ''}">
          <span>Baisse ≥ −15%</span><strong>15 USDC/jour</strong>
        </div>
        <div class="strategy-row ${priceData && !paused && dcaAmountUSD === 20 ? 'active-strat' : ''}">
          <span>Baisse ≥ −20%</span><strong>20 USDC/jour</strong>
        </div>
        <div class="strategy-row ${paused ? 'active-strat strat-pause' : ''}">
          <span>Hausse &gt; +20%</span><strong>⏸ Pause</strong>
        </div>
      </div>
    </div>

    <!-- Action -->
    <div class="card action-card">
      <div class="card-label">ACTION DCA DU JOUR</div>
      ${!walletAddress ? html`
        <p class="hint">Configure d'abord ton wallet pour pouvoir acheter.</p>
        <button class="btn btn-primary" id="btnGoSetup">⚙ Configurer le wallet</button>
      ` : paused ? html`
        <div class="badge badge-red" style="margin-bottom:12px">⏸ DCA suspendu</div>
        <p class="hint">SOL en hausse de ${priceData ? fmtPct(priceData.change30dPct) : '…'} sur 30j (> +20%).<br>Le bot reprendra dès que le cours corrige.</p>
      ` : done ? html`
        <div class="badge badge-green" style="margin-bottom:12px">✓ DCA exécuté aujourd'hui</div>
        <p class="hint">Prochain achat : demain. Les ordres de vente sont actifs.</p>
      ` : html`
        <p class="dca-amount">Montant du jour : <strong>${fmtUSD(dcaAmountUSD)}</strong>
          ${autoOn ? '<span class="auto-badge" style="margin-left:8px">AUTO</span>' : ''}
        </p>
        <button class="btn btn-primary ${isLoading ? 'loading' : ''}" id="btnDCA" ${isLoading ? 'disabled' : ''}>
          ${isLoading ? '⏳ Transaction en cours…' : `▶ Acheter ${fmtUSD(dcaAmountUSD)} de SOL`}
        </button>
        ${autoOn ? '<p class="hint-small">Mode AUTO activé — s\'exécute seul à l\'ouverture de l\'app.</p>' : ''}
      `}
    </div>

    <div class="footer">
      <button class="btn btn-ghost" id="btnRefresh">↻ Actualiser le prix</button>
      <span class="footer-note">Ordres de vente on-chain Jupiter • s'exécutent seuls 24h/24</span>
    </div>`;
}

// ─── Tab: Paramètres ─────────────────────────────────────────────────────────

function renderTabSettings(): string {
  return html`
    <div class="card">
      <div class="card-label">PARAMÈTRES DCA</div>
      <div class="setting-row">
        <label>Montant DCA de base (USDC)</label>
        <input type="number" id="inputBase" value="${state.baseAmountUSD}" min="1" max="1000" step="1" />
      </div>
      <div class="setting-row">
        <label>RPC Solana dédié (optionnel)</label>
        <input type="text" id="inputRPC" value="${state.rpcEndpoint}" placeholder="Laisser vide = RPC publics automatiques" />
      </div>
      <p class="hint-small">
        Vide par défaut (RPC publics gratuits). Pour une fiabilité maximale,
        colle une URL Helius gratuite (helius.dev → crée un compte → copie ton
        « RPC URL »). Ça garantit que tes achats passent même en période chargée.
      </p>
      <button class="btn btn-secondary" id="btnSaveSettings">Enregistrer</button>
    </div>

    <div class="card">
      <div class="card-label">MES ORDRES SUR JUPITER (SOL bloqué)</div>
      <p class="hint">
        Quand un ordre de vente est placé, ton SOL est <strong>verrouillé</strong>
        dedans jusqu'à ce que le prix atteigne la cible. Ici tu vois le SOL bloqué
        et tu peux tout annuler pour le récupérer dans le wallet.
      </p>
      <button class="btn btn-secondary" id="btnViewOrders">🔍 Voir mes ordres ouverts</button>
      <div id="ordersResult" class="hint-small" style="margin:8px 0"></div>
      <button class="btn btn-danger" id="btnCancelAllOrders">✖ Annuler tous les ordres (récupérer le SOL)</button>
    </div>

    <div class="card">
      <div class="card-label">SYNCHRONISER LA POSITION</div>
      <p class="hint">
        Si le tableau de bord ne correspond pas à ton wallet (ex : achats en double
        suite à une erreur réseau), corrige-le ici avec tes chiffres réels.
      </p>
      <button class="btn btn-secondary" id="btnReadWallet">📡 Lire le solde SOL du wallet</button>
      <div id="reconResult" class="hint-small" style="margin:8px 0"></div>

      <div class="setting-row">
        <label>SOL détenu par le bot</label>
        <input type="number" id="inputSolHeld" value="${(state.totalSOLBoughtLamports / LAMPORTS_PER_SOL) || ''}" min="0" step="0.0001" placeholder="0.9333" />
      </div>
      <div class="setting-row">
        <label>Total réellement investi (USDC)</label>
        <input type="number" id="inputInvested" value="${(state.totalUSDCSpentMicro / USDC_DECIMALS) || ''}" min="0" step="1" placeholder="70" />
      </div>
      <button class="btn btn-secondary" id="btnApplyPosition">✔ Appliquer ces chiffres au tableau</button>
      <p class="hint-small">
        Recalcule le prix moyen. Ensuite, replace les ordres de vente pour couvrir
        toute la position.
      </p>
      <button class="btn btn-primary" id="btnReplaceOrders">🔄 Replacer les 4 ordres de vente</button>
    </div>

    <div class="card">
      <div class="card-label">ZONE DANGER</div>
      <p class="hint">Réinitialise tout l'historique et la position. Les ordres on-chain ne sont pas annulés.</p>
      <button class="btn btn-danger" id="btnReset">Réinitialiser tout l'historique</button>
    </div>`;
}

// ─── Render: main view ───────────────────────────────────────────────────────

function renderMain(): string {
  const { autoOn, done, paused } = getCalcs();

  const tabContent = currentTab === 'tableau'
    ? renderTabDashboard()
    : currentTab === 'dca'
      ? renderTabDCA()
      : renderTabSettings();

  const dcaBadge = done ? '✓' : paused ? '⏸' : '●';

  return html`
    <div class="app">
      <header class="header">
        <div class="logo-row"><span class="logo">◎</span><span class="title">SOL DCA Bot</span></div>
        <button class="btn-chip" id="btnSetup">⚙ Wallet</button>
      </header>

      <div class="wallet-bar ${walletAddress ? 'wallet-ok' : 'wallet-missing'}">
        ${walletAddress
          ? html`<span>◉ ${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}</span>
                 ${autoOn ? '<span class="auto-badge">AUTO</span>' : ''}`
          : '<span>⚠ Aucun wallet — configure d\'abord le wallet ⚙</span>'}
      </div>

      <nav class="tabs">
        <button class="tab ${currentTab === 'tableau' ? 'tab-active' : ''}" id="tabTableau">📊 Tableau</button>
        <button class="tab ${currentTab === 'dca' ? 'tab-active' : ''}" id="tabDCA">${dcaBadge} DCA</button>
        <button class="tab ${currentTab === 'reglages' ? 'tab-active' : ''}" id="tabReglages">⚙ Réglages</button>
      </nav>

      <div class="tab-content">
        ${tabContent}
      </div>
    </div>`;
}

// ─── Render: setup view ───────────────────────────────────────────────────────

function renderSetup(): string {
  const hasKey = walletAddress !== null;
  return html`
    <div class="app">
      <header class="header">
        <button class="btn-back" id="btnBack">← Retour</button>
        <span class="title">Configuration Wallet</span>
        <span></span>
      </header>

      <div class="card setup-card">
        <div class="card-label">WALLET BOT (wallet dédié recommandé)</div>
        <p class="setup-info">
          Crée un wallet Solana <strong>dédié</strong> uniquement au bot.
          Mets-y les USDC pour acheter + <strong>au moins 0,01 SOL</strong> pour payer les frais de transaction (quelques centimes).
          Ne pas utiliser le wallet principal.
        </p>

        ${hasKey ? html`
          <div class="badge badge-green" style="margin-bottom:12px">
            ✓ Wallet configuré : ${walletAddress!.slice(0, 6)}…${walletAddress!.slice(-6)}
          </div>
          <p class="hint">Pour changer le wallet, entre une nouvelle clé ci-dessous.</p>
        ` : ''}

        <label class="field-label">Clé privée base58 (64 octets)</label>
        <div class="input-row">
          <input type="password" id="inputPrivKey" placeholder="Colle ta clé privée…" autocomplete="off" />
          <button class="btn-eye" id="btnShowKey">👁</button>
        </div>

        <label class="field-label">PIN de chiffrement (6 chiffres min)</label>
        <input type="password" id="inputPIN" placeholder="PIN" inputmode="numeric" maxlength="12" autocomplete="off" />

        <div class="setting-row" style="margin-top:16px">
          <label><strong>Mode AUTO</strong> — exécute le DCA dès l'ouverture de l'app, sans PIN</label>
          <input type="checkbox" id="chkAuto" ${state.autoExecute ? 'checked' : ''} />
        </div>
        <p class="hint-small">
          En mode AUTO, la clé dérivée est stockée dans l'app pour signer automatiquement.
          Utilise un wallet dédié avec seulement les fonds du DCA.
        </p>

        <button class="btn btn-primary" id="btnSaveKey" style="margin-top:16px">
          ${hasKey ? 'Mettre à jour le wallet' : 'Enregistrer le wallet'}
        </button>

        ${hasKey ? html`
          <button class="btn btn-danger" id="btnClearKey">Supprimer le wallet</button>
        ` : ''}
      </div>

      <div class="card">
        <div class="card-label">RAPPEL QUOTIDIEN (Android uniquement)</div>
        <p class="hint">
          Installe l'app sur l'écran d'accueil (PWA) pour recevoir une notification
          quand le DCA du jour n'a pas été exécuté.
        </p>
        <button class="btn btn-secondary" id="btnNotif">Activer les notifications</button>
      </div>
    </div>`;
}

// ─── Render dispatch ─────────────────────────────────────────────────────────

function render(): void {
  document.getElementById('app')!.innerHTML =
    view === 'setup' ? renderSetup() : renderMain();
  bindEvents();
}

function bindEvents(): void {
  if (view === 'setup') {
    on('btnBack', 'click', () => { view = 'main'; render(); });
    on('btnShowKey', 'click', () => {
      const inp = document.getElementById('inputPrivKey') as HTMLInputElement;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    on('btnSaveKey', 'click', () => handleSaveKey());
    on('btnClearKey', 'click', () => handleClearKey());
    on('btnNotif',   'click', () => requestNotifPermission());
    return;
  }

  // main view — tabs
  on('tabTableau',  'click', () => { currentTab = 'tableau';  render(); });
  on('tabDCA',      'click', () => { currentTab = 'dca';      render(); });
  on('tabReglages', 'click', () => { currentTab = 'reglages'; render(); });

  on('btnSetup',   'click', () => { view = 'setup'; render(); });
  on('btnGoSetup', 'click', () => { view = 'setup'; render(); });
  on('btnDCA',     'click', () => { if (!isLoading) void handleDCA(); });
  on('btnRefresh', 'click', () => void refreshPrice().then(render));
  on('btnSaveSettings', 'click', () => {
    const base = parseFloat((document.getElementById('inputBase') as HTMLInputElement).value);
    const rpc  = (document.getElementById('inputRPC') as HTMLInputElement).value.trim();
    if (!isNaN(base) && base > 0) state.baseAmountUSD = base;
    state.rpcEndpoint = rpc; // empty = use the proxy's public RPC pool
    saveState(state);
    render();
  });
  on('btnReset', 'click', () => {
    if (confirm('Réinitialiser tout l\'historique et la position ? Irréversible.')) {
      state = resetState();
      render();
    }
  });
  on('btnReadWallet', 'click', () => void handleReadWallet());
  on('btnApplyPosition', 'click', () => handleApplyPosition());
  on('btnReplaceOrders', 'click', () => { if (!isLoading) void handleReplaceSellOrders(); });
  on('btnViewOrders', 'click', () => void handleViewOrders());
  on('btnCancelAllOrders', 'click', () => { if (!isLoading) void handleCancelAllOrders(); });
}

// ─── Jupiter open orders (locked SOL) ────────────────────────────────────────

let lastFetchedOrderKeys: string[] = [];

async function handleViewOrders(): Promise<void> {
  if (!walletAddress) { alert('Configure d\'abord le wallet.'); return; }
  const el = document.getElementById('ordersResult');
  if (el) el.textContent = '⏳ Lecture des ordres sur Jupiter…';
  try {
    const orders = await fetchOpenOrders(walletAddress);
    lastFetchedOrderKeys = orders.map(o => o.orderKey);
    const totalLocked = orders.reduce((s, o) => s + o.makingLamports, 0) / LAMPORTS_PER_SOL;
    if (el) {
      el.innerHTML = orders.length === 0
        ? 'Aucun ordre ouvert. Ton SOL (s\'il y en a) est libre dans le wallet.'
        : `<strong>${orders.length} ordre(s) ouvert(s)</strong> — ${fmt(totalLocked, 4)} SOL bloqué au total, ` +
          `en attente que le prix atteigne les cibles. Annule pour récupérer ce SOL dans le wallet.`;
    }
  } catch (e) {
    if (el) el.textContent = `Erreur : ${(e as Error).message}`;
  }
}

async function handleCancelAllOrders(): Promise<void> {
  if (!walletAddress) { alert('Configure d\'abord le wallet.'); return; }
  // Refresh the order list first so we cancel what's actually open.
  let keys = lastFetchedOrderKeys;
  if (keys.length === 0) {
    const orders = await fetchOpenOrders(walletAddress).catch(() => []);
    keys = orders.map(o => o.orderKey);
  }
  if (keys.length === 0) { alert('Aucun ordre ouvert à annuler.'); return; }
  if (!confirm(
    `Annuler ${keys.length} ordre(s) ? Le SOL verrouillé reviendra dans ton wallet ` +
    `(en SOL, pas en USDC). Coûte quelques frais.`,
  )) return;

  isLoading = true;
  render();
  try {
    const keypair = await loadKeypairForExecution();
    if (!keypair) { isLoading = false; render(); return; }
    const pubkey = keypair.publicKey.toBase58();

    const cancelTxs = await buildCancelOrdersTransaction(keys, pubkey);
    let ok = 0;
    for (const tx of cancelTxs) {
      try { await signAndSendLocal(tx, keypair, state.rpcEndpoint); ok++; }
      catch (e) { console.warn('Annulation échouée:', e); }
    }

    // Mark local sell orders as cancelled to keep the dashboard in sync.
    state.sellOrders = state.sellOrders.map(o =>
      o.status === 'active' ? { ...o, status: 'cancelled' as const } : o,
    );
    saveState(state);
    lastFetchedOrderKeys = [];
    alert(
      `✅ ${ok}/${cancelTxs.length} ordre(s) annulé(s). Le SOL revient dans ton wallet.\n` +
      `Pour le reconvertir en USDC, il faudrait le vendre (ce que font les ordres au prix cible).`,
    );
  } catch (err) {
    alert(`Erreur : ${(err as Error).message}`);
  } finally {
    isLoading = false;
    render();
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

async function handleReadWallet(): Promise<void> {
  if (!walletAddress) { alert('Configure d\'abord le wallet.'); return; }
  const el = document.getElementById('reconResult');
  if (el) el.textContent = '⏳ Lecture du solde…';
  try {
    const lamports = await getWalletSolLamports(walletAddress, state.rpcEndpoint);
    const sol = lamports / LAMPORTS_PER_SOL;
    // Suggest position = balance minus a small fee reserve.
    const suggested = Math.max(0, sol - 0.02);
    const inp = document.getElementById('inputSolHeld') as HTMLInputElement | null;
    if (inp && suggested > 0) inp.value = suggested.toFixed(4);
    if (el) {
      el.textContent =
        `Solde wallet : ${fmt(sol, 4)} SOL. Suggestion pour le bot : ${fmt(suggested, 4)} SOL ` +
        `(0,02 SOL gardés pour les frais). Ajuste si besoin, puis Applique.`;
    }
  } catch (e) {
    if (el) el.textContent = `Erreur lecture wallet : ${(e as Error).message}`;
  }
}

function handleApplyPosition(): void {
  const solHeld = parseFloat((document.getElementById('inputSolHeld') as HTMLInputElement).value);
  const invested = parseFloat((document.getElementById('inputInvested') as HTMLInputElement).value);
  if (isNaN(solHeld) || solHeld <= 0) { alert('Entre le nombre de SOL détenu.'); return; }
  if (isNaN(invested) || invested <= 0) { alert('Entre le total investi en USDC.'); return; }

  state.totalSOLBoughtLamports = Math.round(solHeld * LAMPORTS_PER_SOL);
  state.totalUSDCSpentMicro = Math.round(invested * USDC_DECIMALS);
  state.averageBuyPriceUSD = invested / solHeld;
  saveState(state);
  alert(
    `✅ Position mise à jour.\n` +
    `${fmt(solHeld, 4)} SOL • investi ${fmtUSD(invested)}\n` +
    `Prix moyen : ${fmtUSD(state.averageBuyPriceUSD)}\n\n` +
    `Pense à replacer les ordres de vente pour couvrir toute la position.`,
  );
  currentTab = 'tableau';
  render();
}

async function handleReplaceSellOrders(): Promise<void> {
  if (state.totalSOLBoughtLamports <= 0 || state.averageBuyPriceUSD <= 0) {
    alert('Applique d\'abord ta position (SOL détenu + investi).');
    return;
  }
  if (!confirm(
    'Annuler les ordres de vente existants et en placer 4 nouveaux pour toute la ' +
    'position ? Cela coûte quelques frais de transaction.',
  )) return;

  isLoading = true;
  render();
  try {
    const keypair = await loadKeypairForExecution();
    if (!keypair) { isLoading = false; render(); return; }
    const pubkey = keypair.publicKey.toBase58();

    // Cancel existing active orders
    const activeAccounts = state.sellOrders
      .filter(o => o.status === 'active' && o.accountPubkey)
      .map(o => o.accountPubkey);
    if (activeAccounts.length > 0) {
      const cancelTxs = await buildCancelOrdersTransaction(activeAccounts, pubkey);
      for (const tx of cancelTxs) {
        await signAndSendLocal(tx, keypair, state.rpcEndpoint).catch(console.warn);
      }
    }

    // Place fresh orders for the full position
    const specs = buildSellOrderSpecs(state.totalSOLBoughtLamports, state.averageBuyPriceUSD);
    const placedAccounts: string[] = [];
    for (const spec of specs) {
      try {
        const { tx, orderAccount } = await buildLimitOrderTransaction(spec, pubkey);
        await signAndSendLocal(tx, keypair, state.rpcEndpoint);
        placedAccounts.push(orderAccount);
      } catch (err) {
        console.error(`Ordre +${spec.targetPct}% échoué:`, err);
        placedAccounts.push('');
      }
    }
    const okCount = placedAccounts.filter(a => a).length;
    state.sellOrders = replaceSellOrders(state.sellOrders, specs, placedAccounts);
    saveState(state);
    alert(`✅ ${okCount}/${specs.length} ordres de vente placés pour toute la position.`);
    currentTab = 'tableau';
  } catch (err) {
    alert(`Erreur : ${(err as Error).message}`);
  } finally {
    isLoading = false;
    render();
  }
}

// ─── Setup handlers ──────────────────────────────────────────────────────────

async function handleSaveKey(): Promise<void> {
  const privKey = (document.getElementById('inputPrivKey') as HTMLInputElement).value.trim();
  const pin     = (document.getElementById('inputPIN') as HTMLInputElement).value;
  const autoOn  = (document.getElementById('chkAuto') as HTMLInputElement).checked;

  if (!privKey) { alert('Entre ta clé privée.'); return; }
  if (pin.length < 6) { alert('PIN trop court (6 chiffres minimum).'); return; }

  try {
    // Validate key by creating keypair
    const kp = keypairFromBase58(privKey);
    const addr = kp.publicKey.toBase58();

    // Encrypt and save
    const blob = await encryptKey(privKey, pin);
    await saveEncryptedKey(blob);
    await saveWalletAddress(addr);

    if (autoOn) {
      const rawKey = await exportAutoKey(pin, blob.salt);
      await saveAutoKey(rawKey);
    } else {
      await clearAutoKey();
    }

    // Load keypair into session
    activeKeypair = kp;
    walletAddress = addr;
    state.walletMode  = 'local';
    state.autoExecute = autoOn;
    saveState(state);

    await registerPeriodicSync();

    alert(`✅ Wallet enregistré !\n${addr.slice(0, 8)}…\nMode AUTO : ${autoOn ? 'Activé' : 'Désactivé'}`);
    view = 'main';
    render();
  } catch (e) {
    alert(`Erreur : ${(e as Error).message}`);
  }
}

async function handleClearKey(): Promise<void> {
  if (!confirm('Supprimer le wallet du bot ? L\'historique est conservé.')) return;
  await clearAutoKey();
  activeKeypair = null;
  walletAddress = null;
  state.walletMode  = 'none' as AppState['walletMode'];
  state.autoExecute = false;
  saveState(state);
  render();
}

async function requestNotifPermission(): Promise<void> {
  if (!('Notification' in window)) {
    alert('Les notifications ne sont pas supportées sur cet appareil.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    alert('✅ Notifications activées ! Tu recevras un rappel si le DCA du jour n\'est pas fait.');
  } else {
    alert('Notifications refusées. Active-les dans les paramètres du navigateur.');
  }
}

// ─── DCA execution ───────────────────────────────────────────────────────────

async function loadKeypairForExecution(): Promise<Keypair | null> {
  // Already in session memory
  if (activeKeypair) return activeKeypair;

  // Try auto mode (no PIN needed)
  const rawKey = await loadAutoKey();
  if (rawKey) {
    const aesKey = await importAutoKey(rawKey);
    const blob   = await loadEncryptedKey();
    if (blob) {
      try {
        const privKey = await decryptWithAutoKey(aesKey, blob);
        activeKeypair = keypairFromBase58(privKey);
        return activeKeypair;
      } catch { /* fall through */ }
    }
  }

  // Manual PIN entry needed
  const pin = prompt('Entre ton PIN pour signer la transaction :');
  if (!pin) return null;
  const blob = await loadEncryptedKey();
  if (!blob) return null;
  try {
    const privKey = await decryptKey(blob, pin);
    activeKeypair = keypairFromBase58(privKey);
    return activeKeypair;
  } catch {
    alert('PIN incorrect.');
    return null;
  }
}

async function handleDCA(): Promise<void> {
  if (!priceData) { await refreshPrice(); }
  if (!priceData) { alert('Prix non disponible, réessaie.'); return; }

  const dcaAmountUSD = calcDCAAmountUSD(priceData.change30dPct, state.baseAmountUSD);
  if (dcaAmountUSD === 0 || isDCADoneToday(state)) return;

  isLoading = true;
  render();

  try {
    const keypair = await loadKeypairForExecution();
    if (!keypair) { isLoading = false; render(); return; }

    const pubkey = keypair.publicKey.toBase58();

    // 1. Quote
    const quote = await getSwapQuote(dcaAmountUSD).catch(e => {
      throw new Error(`Étape 1 (quote Jupiter) : ${(e as Error).message}`);
    });

    // 2. Build + send swap tx
    const swapTx = await buildSwapTransaction(quote, pubkey).catch(e => {
      throw new Error(`Étape 2 (construction swap) : ${(e as Error).message}`);
    });
    const swapSig = await signAndSendLocal(swapTx, keypair, state.rpcEndpoint).catch(e => {
      throw new Error(`Étape 3 (envoi RPC) : ${(e as Error).message}`);
    });

    // 3. Update position
    const usdcMicro = Math.floor(dcaAmountUSD * USDC_DECIMALS);
    const updated = updateAverageCost(state, quote.outAmountLamports, usdcMicro);
    state = { ...state, ...updated };

    // 4. Record history
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
    await saveLastDCADate(todayISO());

    // 5. Cancel old sell orders
    const activeAccounts = state.sellOrders
      .filter(o => o.status === 'active' && o.accountPubkey)
      .map(o => o.accountPubkey);
    if (activeAccounts.length > 0) {
      const cancelTxs = await buildCancelOrdersTransaction(activeAccounts, pubkey);
      for (const cancelTx of cancelTxs) {
        await signAndSendLocal(cancelTx, keypair, state.rpcEndpoint).catch(console.warn);
      }
    }

    // 6. Place new sell orders
    const specs = buildSellOrderSpecs(state.totalSOLBoughtLamports, state.averageBuyPriceUSD);
    const placedAccounts: string[] = [];
    for (const spec of specs) {
      try {
        const { tx, orderAccount } = await buildLimitOrderTransaction(spec, pubkey);
        await signAndSendLocal(tx, keypair, state.rpcEndpoint);
        placedAccounts.push(orderAccount);
      } catch (err) {
        console.error(`Ordre +${spec.targetPct}% échoué:`, err);
        placedAccounts.push('');
      }
    }
    state.sellOrders = replaceSellOrders(state.sellOrders, specs, placedAccounts);
    saveState(state);

    alert(`✅ DCA exécuté automatiquement !\n${fmtUSD(dcaAmountUSD)} → ${fmtSOL(quote.outAmountLamports)}\nPrix moyen : ${fmtUSD(state.averageBuyPriceUSD)}`);
  } catch (err) {
    console.error(err);
    const msg = (err as Error).message;
    if (!msg.toLowerCase().includes('rejet') && !msg.toLowerCase().includes('reject')) {
      alert(`Erreur : ${msg}`);
    }
  } finally {
    isLoading = false;
    render();
  }
}

// ─── Price refresh ────────────────────────────────────────────────────────────

async function refreshPrice(): Promise<void> {
  try {
    priceData = await fetchPriceData();
  } catch (e) {
    console.warn('Prix non disponible:', e);
  }
}

// ─── Service worker registration ──────────────────────────────────────────────

async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.warn('SW non enregistré:', e);
  }
}

async function registerPeriodicSync(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (reg as any).periodicSync.register('daily-dca-reminder', {
        minInterval: 24 * 60 * 60 * 1000,
      });
    }
  } catch { /* not supported on this device */ }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Register service worker
  void registerSW();

  // Restore wallet address from DB
  walletAddress = await loadWalletAddress();
  if (walletAddress) {
    // Try to load keypair silently via auto mode
    const rawKey = await loadAutoKey();
    if (rawKey) {
      const aesKey = await importAutoKey(rawKey);
      const blob   = await loadEncryptedKey();
      if (blob) {
        try {
          const privKey = await decryptWithAutoKey(aesKey, blob);
          activeKeypair = keypairFromBase58(privKey);
        } catch { /* will ask PIN when needed */ }
      }
    }
  }

  render();
  await refreshPrice();
  render();

  // Auto-execute DCA if mode auto is on and DCA not done today
  if (
    activeKeypair &&
    state.walletMode === 'local' &&
    state.autoExecute &&
    !isDCADoneToday(state) &&
    priceData &&
    !isLoading
  ) {
    await handleDCA();
  }

  // Refresh price every 5 minutes
  setInterval(async () => { await refreshPrice(); render(); }, 5 * 60 * 1000);
}

boot();
