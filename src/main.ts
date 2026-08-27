import './style.css';
import type { AppState, DCAEntry } from './types';
import { loadState, saveState, resetState, isDCADoneToday, todayISO } from './store';
import { fetchPriceData } from './price';
import {
  calcDCAAmountUSD,
  updateAverageCost,
  averageCostFromHistory,
  buildAdaptiveSellOrderSpecs,
  recordDCAEntry,
  replaceSellOrders,
  LAMPORTS_PER_SOL,
  USDC_DECIMALS,
} from './strategy';
import {
  getSwapQuote,
  buildSwapTransaction,
  createSellOrder,
  createCancelOrders,
  fetchOpenOrders,
} from './jupiter';
import { Keypair } from '@solana/web3.js';
import {
  keypairFromBase58, signAndSendLocal, executeTrigger,
  getWalletSolLamports, getWalletUsdcMicro, getSignatureOutcome,
} from './signer';
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
// Live wallet balances (refreshed on boot, after each DCA, and periodically)
let walletUsdcMicro: number | null = null;
let walletSolLamports: number | null = null;

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
  const avgCost   = averageCostFromHistory(state.dcaHistory) || state.averageBuyPriceUSD;
  // Real current holding = free wallet SOL + SOL still locked in active sell
  // orders. This automatically drops when an order fills (sold SOL leaves both),
  // unlike the gross "total bought". Falls back to the tracked total until the
  // live balance has loaded.
  const lockedLamports = state.sellOrders
    .filter(o => o.status === 'active')
    .reduce((s, o) => s + o.solLamports, 0);
  const heldLamports = walletSolLamports !== null
    ? Math.max(0, walletSolLamports + lockedLamports)
    : state.totalSOLBoughtLamports;
  const posSOL    = heldLamports / LAMPORTS_PER_SOL;
  const cur       = priceData?.currentUSD ?? 0;
  const posValue  = posSOL * (cur || avgCost);
  const invested  = state.totalUSDCSpentMicro / USDC_DECIMALS;
  // Latent (unrealised) P&L on the SOL still held, vs its average cost.
  // Realised proceeds from past sales live in the wallet's USDC balance.
  const pnl       = posSOL > 0 && cur > 0 ? posSOL * (cur - avgCost) : 0;
  const pnlPct    = avgCost > 0 && cur > 0 ? (cur / avgCost - 1) * 100 : 0;
  const done      = isDCADoneToday(state);
  const paused    = dcaAmountUSD === 0;
  const autoOn    = state.walletMode === 'local' && state.autoExecute;
  return { dcaAmountUSD, posSOL, posValue, invested, pnl, pnlPct, done, paused, autoOn };
}

// ─── Tab: Tableau de bord ────────────────────────────────────────────────────

function renderTabDashboard(): string {
  const { posSOL, posValue, invested, pnl, pnlPct } = getCalcs();
  const cur = priceData?.currentUSD ?? 0;
  // True DCA cost basis from history (immune to manual-action corruption).
  const avg = averageCostFromHistory(state.dcaHistory) || state.averageBuyPriceUSD;
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
        <div class="stat-label">SOL détenu</div>
        <div class="stat-value">${posSOL > 0 ? fmt(posSOL, 4) : '0'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Nb d'achats</div>
        <div class="stat-value">${state.dcaHistory.length}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">USDC disponible</div>
        <div class="stat-value">${walletUsdcMicro !== null ? fmt(walletUsdcMicro / USDC_DECIMALS) : '—'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Réserve de DCA</div>
        <div class="stat-value">${(() => {
          if (walletUsdcMicro === null) return '—';
          const amt = getCalcs().dcaAmountUSD;
          if (amt <= 0) return '⏸';
          const days = Math.floor(walletUsdcMicro / USDC_DECIMALS / amt);
          return html`≈ ${days} j<br><span class="stat-sub">à ${fmtUSD(amt)}/jour</span>`;
        })()}</div>
      </div>
    </div>

    ${walletSolLamports !== null && walletSolLamports < 0.005 * LAMPORTS_PER_SOL ? html`
      <div class="card" style="border:1px solid #b8544a">
        <p class="hint" style="margin:0">
          ⚠️ <strong>SOL de frais presque épuisé</strong> (${fmtSOL(walletSolLamports)}).
          Envoie ~0,02 SOL au wallet bot, sinon les prochaines transactions échoueront.
        </p>
      </div>` : ''}

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
      <div class="card-label">PROTÉGER MA POSITION</div>
      <p class="hint">
        Place les 4 ordres de vente sur le SOL <strong>libre</strong> de ton wallet,
        avec des cibles calculées <strong>au-dessus du cours actuel</strong> (+10/+20/+40/+60 %).
        Aucune vente à perte possible. Ne rachète rien. Garde une petite réserve de SOL
        pour les frais.
      </p>
      <button class="btn btn-primary ${isLoading ? 'loading' : ''}" id="btnProtect" ${isLoading ? 'disabled' : ''}>
        🛡️ Placer les ordres sur ma position actuelle
      </button>
    </div>

    <div class="card">
      <div class="card-label">INFOS WALLET (lecture seule)</div>
      <p class="hint">
        Affiche les soldes réels de ton wallet bot. Aucune action de vente ici —
        lecture uniquement.
      </p>
      <button class="btn btn-secondary" id="btnReadWallet">📡 Lire les soldes (SOL + USDC)</button>
      <div id="reconResult" class="hint-small" style="margin:8px 0"></div>
    </div>

    <div class="card">
      <div class="card-label">SAUVEGARDE</div>
      <p class="hint">
        Télécharge l'historique et la position du bot (fichier JSON). L'historique
        vit dans le navigateur : si tu effaces ses données, il est perdu — pas tes
        fonds, qui restent sur la blockchain. Garde aussi ta clé privée en lieu sûr :
        elle seule donne accès au wallet.
      </p>
      <button class="btn btn-secondary" id="btnExport">💾 Exporter l'historique (JSON)</button>
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
  on('btnRefresh', 'click', () => void (async () => {
    await refreshPrice();
    await syncOrdersFromChain();
    await loadBalances();
    render();
  })());
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
  on('btnViewOrders', 'click', () => void handleViewOrders());
  on('btnCancelAllOrders', 'click', () => { if (!isLoading) void handleCancelAllOrders(); });
  on('btnProtect', 'click', () => { if (!isLoading) void handleProtectPosition(); });
  on('btnExport', 'click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sol-dca-bot-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// Place sell orders on the wallet's free SOL, targets ABOVE current market.
async function handleProtectPosition(): Promise<void> {
  if (!walletAddress) { alert('Configure d\'abord le wallet.'); return; }
  if (!priceData) { await refreshPrice(); }
  if (!priceData || !(priceData.currentUSD > 0)) {
    alert('Prix du marché indisponible, réessaie dans un instant.');
    return;
  }
  const marketPrice = priceData.currentUSD;
  // Thresholds use the true DCA cost basis (history). Only when there is no
  // buy history at all do we fall back to the current market price.
  const refPrice = averageCostFromHistory(state.dcaHistory) || marketPrice;
  const usingHistory = refPrice !== marketPrice;

  if (!confirm(
    `Placer les ordres de vente sur ton SOL libre, aux paliers +10/+20/+40/+60% ` +
    `${usingHistory ? `de ton prix moyen DCA (${fmtUSD(refPrice)})` : `du cours actuel (${fmtUSD(marketPrice)})`} ? ` +
    `Une réserve de ~0,04 SOL est gardée pour les frais.`,
  )) return;

  isLoading = true;
  render();
  try {
    const keypair = await loadKeypairForExecution();
    if (!keypair) { isLoading = false; render(); return; }
    const pubkey = keypair.publicKey.toBase58();

    const lamports = await getWalletSolLamports(walletAddress, state.rpcEndpoint);
    const feeReserve = Math.floor(0.04 * LAMPORTS_PER_SOL);
    const positionLamports = lamports - feeReserve;
    if (positionLamports <= 0) {
      alert('Pas assez de SOL libre pour placer des ordres (garde ~0,04 SOL de frais).');
      isLoading = false; render();
      return;
    }

    // Cancel any pre-existing open orders first, to avoid double-locking SOL.
    const existing = await fetchOpenOrders(walletAddress).catch(() => []);
    if (existing.length > 0) {
      const cancelTxs = await createCancelOrders(existing.map(o => o.orderKey), pubkey);
      for (const ct of cancelTxs) await executeTrigger(ct, keypair).catch(console.warn);
    }

    // Targets based on the true DCA cost basis (or market if no history).
    const specs = buildAdaptiveSellOrderSpecs(positionLamports, refPrice);
    if (specs.length === 0) {
      alert(
        'Position trop petite pour placer un ordre : Jupiter exige au moins ' +
        '5 USD par ordre. Accumule davantage de SOL puis réessaie.',
      );
      isLoading = false; render();
      return;
    }
    const placedAccounts: string[] = [];
    const errors: string[] = [];
    for (const spec of specs) {
      try {
        const t = await createSellOrder(spec, pubkey, marketPrice);
        await executeTrigger(t, keypair);
        placedAccounts.push(t.order ?? '');
      } catch (err) {
        console.error(`Ordre +${spec.targetPct}% non placé:`, err);
        errors.push((err as Error).message);
        placedAccounts.push('');
      }
    }
    const okSpecs = specs.filter((_, i) => placedAccounts[i]);
    const okAccounts = placedAccounts.filter(a => a);

    // Record the placed orders only. The DCA history remains the single source
    // of truth for the cost basis — never overwrite it here.
    state.sellOrders = replaceSellOrders(state.sellOrders, okSpecs, okAccounts);
    if (okAccounts.length > 0) state.lastOrdersPlacedAt = Date.now();
    saveState(state);

    alert(
      `✅ ${okAccounts.length}/${specs.length} ordres de vente placés ` +
      `(paliers du prix moyen ${fmtUSD(refPrice)}).` +
      (okAccounts.length < specs.length && errors.length
        ? `\n⚠️ Échec. Détail : ${errors[0]}`
        : ''),
    );
    currentTab = 'tableau';
  } catch (err) {
    alert(`Erreur : ${(err as Error).message}`);
  } finally {
    isLoading = false;
    render();
  }
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
    if (el) {
      el.innerHTML = orders.length === 0
        ? 'Aucun ordre ouvert. Ton SOL (s\'il y en a) est libre dans le wallet.'
        : `<strong>${orders.length} ordre(s) de vente ouvert(s)</strong> sur Jupiter, en attente ` +
          `que le prix atteigne les cibles. Les montants sont dans l'onglet Tableau. ` +
          `« Annuler » récupère le SOL dans le wallet.`;
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

    const cancelTxs = await createCancelOrders(keys, pubkey);
    let ok = 0;
    for (const ct of cancelTxs) {
      try { await executeTrigger(ct, keypair); ok++; }
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
  if (el) el.textContent = '⏳ Lecture du solde du wallet bot…';
  try {
    const [lamports, usdcMicro] = await Promise.all([
      getWalletSolLamports(walletAddress, state.rpcEndpoint),
      getWalletUsdcMicro(walletAddress, state.rpcEndpoint).catch(() => 0),
    ]);
    const sol = lamports / LAMPORTS_PER_SOL;
    const usdc = usdcMicro / USDC_DECIMALS;
    if (el) {
      el.innerHTML =
        `<strong>Wallet bot ${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}</strong><br>` +
        `• SOL : <strong>${fmt(sol, 4)} SOL</strong><br>` +
        `• USDC : <strong>${fmt(usdc, 2)} USDC</strong>`;
    }
  } catch (e) {
    if (el) el.textContent = `Erreur lecture wallet : ${(e as Error).message}`;
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

// ─── Pending-buy resolution (anti double-achat) ──────────────────────────────
// If a previous swap was broadcast but its confirmation failed/timed out, we
// must learn its real outcome before ever buying again.

async function resolvePendingDCA(): Promise<'recorded' | 'cleared' | 'wait' | 'none'> {
  const p = state.pendingDCA;
  if (!p) return 'none';

  const outcome = await getSignatureOutcome(p.signature, state.rpcEndpoint);

  if (outcome === 'confirmed') {
    // The "failed" buy actually landed → record it, don't buy again today.
    const updated = updateAverageCost(
      state, p.solLamports, Math.floor(p.amountUSD * USDC_DECIMALS),
    );
    state = { ...state, ...updated };
    state.dcaHistory = recordDCAEntry(state, {
      date: p.date,
      amountUSD: p.amountUSD,
      solPriceUSD: p.priceUSD,
      solBoughtLamports: p.solLamports,
      txSignature: p.signature,
    });
    state.lastDCADate = p.date;
    state.pendingDCA = null;
    saveState(state);
    await saveLastDCADate(p.date);
    return 'recorded';
  }

  if (outcome === 'failed') {
    state.pendingDCA = null;
    saveState(state);
    return 'cleared';
  }

  // Unknown: the tx may still land within its blockhash window (~1 min).
  // Only clear once it's old enough to be definitively dead.
  if (Date.now() - p.sentAt > 5 * 60_000) {
    state.pendingDCA = null;
    saveState(state);
    return 'cleared';
  }
  return 'wait';
}

// ─── On-chain order sync ─────────────────────────────────────────────────────
// A locally-"active" order that no longer appears in Jupiter's open orders is
// no longer live. We can't tell a fill from an on-chain cancellation just from
// its disappearance, so mark it "closed" (cancelled) rather than fabricate a
// sale. A real fill is still visible as USDC arriving in the wallet balance.

async function syncOrdersFromChain(): Promise<void> {
  if (!walletAddress) return;
  const hasActive = state.sellOrders.some(o => o.status === 'active' && o.accountPubkey);
  if (!hasActive) return;
  // Jupiter's indexer can lag right after placement — don't sync too soon.
  if (Date.now() - (state.lastOrdersPlacedAt || 0) < 10 * 60_000) return;

  try {
    const open = await fetchOpenOrders(walletAddress);
    const openKeys = new Set(open.map(o => o.orderKey));
    let changed = false;
    state.sellOrders = state.sellOrders.map(o => {
      if (o.status === 'active' && o.accountPubkey && !openKeys.has(o.accountPubkey)) {
        changed = true;
        return { ...o, status: 'cancelled' as const };
      }
      return o;
    });
    if (changed) saveState(state);
  } catch { /* API unreachable — try again next cycle */ }
}

// ─── Wallet balances (dashboard info) ────────────────────────────────────────

async function loadBalances(): Promise<void> {
  if (!walletAddress) return;
  const [sol, usdc] = await Promise.all([
    getWalletSolLamports(walletAddress, state.rpcEndpoint).catch(() => null),
    getWalletUsdcMicro(walletAddress, state.rpcEndpoint).catch(() => null),
  ]);
  if (sol !== null) walletSolLamports = sol;
  if (usdc !== null) walletUsdcMicro = usdc;
}

async function handleDCA(): Promise<void> {
  if (!priceData) { await refreshPrice(); }
  if (!priceData) { alert('Prix non disponible, réessaie.'); return; }

  // Never buy while a previous buy's outcome is unknown.
  const resolution = await resolvePendingDCA();
  if (resolution === 'recorded') {
    alert(
      'ℹ️ Le précédent achat marqué "échoué" avait en réalité réussi sur la blockchain.\n' +
      'Il vient d\'être enregistré — pas de nouvel achat aujourd\'hui (double achat évité).',
    );
    render();
    return;
  }
  if (resolution === 'wait') {
    alert('⏳ Une transaction précédente est peut-être encore en cours.\nAttends 2 minutes puis réessaie.');
    return;
  }

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

    // 2. Build + send swap tx. The signature is persisted the moment the tx
    //    is broadcast: if confirmation then fails/times out, the next attempt
    //    resolves the real outcome instead of buying twice.
    const swapTx = await buildSwapTransaction(quote, pubkey).catch(e => {
      throw new Error(`Étape 2 (construction swap) : ${(e as Error).message}`);
    });
    const swapSig = await signAndSendLocal(swapTx, keypair, state.rpcEndpoint, sig => {
      state.pendingDCA = {
        date: todayISO(),
        signature: sig,
        amountUSD: dcaAmountUSD,
        solLamports: quote.outAmountLamports,
        priceUSD: quote.priceUSD,
        sentAt: Date.now(),
      };
      saveState(state);
    }).catch(e => {
      throw new Error(`Étape 3 (envoi RPC) : ${(e as Error).message}`);
    });

    // Confirmed → the pending marker is no longer needed.
    state.pendingDCA = null;

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

    // 5. Cancel old sell orders (create → sign → Jupiter /execute)
    const activeAccounts = state.sellOrders
      .filter(o => o.status === 'active' && o.accountPubkey)
      .map(o => o.accountPubkey);
    if (activeAccounts.length > 0) {
      const cancelTxs = await createCancelOrders(activeAccounts, pubkey);
      for (const ct of cancelTxs) {
        await executeTrigger(ct, keypair).catch(console.warn);
      }
    }

    // 6. Place new sell orders (always ABOVE market — hard guard in
    //    createSellOrder refuses any target at/below market price).
    //    Thresholds come from the true DCA cost basis (buy history), never a
    //    stored value that manual actions could have corrupted.
    //    Quantity is sized against the ACTUAL free SOL minus a reserve for the
    //    orders' own rent + fees, so the last (+60%) order can always be funded
    //    — never against the tracked total, which may exceed the wallet balance.
    //    Only orders that ACTUALLY execute on-chain are recorded as active.
    const avgCost = averageCostFromHistory(state.dcaHistory) || state.averageBuyPriceUSD;
    const freeSol = await getWalletSolLamports(pubkey, state.rpcEndpoint)
      .catch(() => state.totalSOLBoughtLamports);
    const orderReserve = Math.floor(0.03 * LAMPORTS_PER_SOL); // rent + fees for the orders
    const sellableLamports = Math.max(
      0, Math.min(state.totalSOLBoughtLamports, freeSol - orderReserve),
    );
    const specs = buildAdaptiveSellOrderSpecs(sellableLamports, avgCost);
    const placedAccounts: string[] = [];
    const marketPrice = priceData?.currentUSD ?? 0;
    for (const spec of specs) {
      try {
        const triggerTx = await createSellOrder(spec, pubkey, marketPrice);
        await executeTrigger(triggerTx, keypair);
        placedAccounts.push(triggerTx.order ?? '');
      } catch (err) {
        console.error(`Ordre +${spec.targetPct}% non placé:`, err);
        placedAccounts.push('');
      }
    }
    // Record only successfully placed orders (non-empty account) as active.
    const okSpecs = specs.filter((_, i) => placedAccounts[i]);
    const okAccounts = placedAccounts.filter(a => a);
    state.sellOrders = replaceSellOrders(state.sellOrders, okSpecs, okAccounts);
    if (okAccounts.length > 0) state.lastOrdersPlacedAt = Date.now();
    saveState(state);

    void loadBalances().then(render);

    const placedCount = okAccounts.length;
    alert(
      `✅ DCA exécuté !\n${fmtUSD(dcaAmountUSD)} → ${fmtSOL(quote.outAmountLamports)}\n` +
      `Prix moyen : ${fmtUSD(avgCost)}\n` +
      `Ordres de vente placés : ${placedCount}/${specs.length}` +
      (placedCount < specs.length ? '\n⚠️ Certains ordres n\'ont pas été placés — réessaie ou vérifie "Voir mes ordres ouverts".' : ''),
    );
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

  // Resolve any buy whose confirmation previously failed (never double-buy),
  // then sync sell-order statuses and balances with the chain.
  const resolution = await resolvePendingDCA();
  if (resolution === 'recorded') {
    alert(
      'ℹ️ Un achat précédent marqué "échoué" avait en réalité réussi.\n' +
      'Il a été enregistré dans l\'historique (double achat évité).',
    );
  }
  await syncOrdersFromChain();
  void loadBalances().then(render);
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

  // Periodic refresh: price, order statuses, balances
  setInterval(async () => {
    await refreshPrice();
    await syncOrdersFromChain();
    await loadBalances();
    render();
  }, 5 * 60 * 1000);
}

boot();
