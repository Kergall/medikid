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
import { Keypair } from '@solana/web3.js';
import { keypairFromBase58, signAndSendLocal } from './signer';
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

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function fmt(n: number, d = 2): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtUSD = (n: number) => `$${fmt(n)}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n, 1)}%`;
const fmtSOL = (l: number) => `${fmt(l / LAMPORTS_PER_SOL, 4)} SOL`;

function html(strings: TemplateStringsArray, ...vals: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '');
}

function on(id: string, ev: string, fn: EventListener): void {
  document.getElementById(id)?.addEventListener(ev, fn);
}

// ─── Render: main view ───────────────────────────────────────────────────────

function renderMain(): string {
  const dcaAmountUSD = priceData
    ? calcDCAAmountUSD(priceData.change30dPct, state.baseAmountUSD)
    : state.baseAmountUSD;
  const posSOL = state.totalSOLBoughtLamports / LAMPORTS_PER_SOL;
  const posValue = posSOL * (priceData?.currentUSD ?? state.averageBuyPriceUSD);
  const invested = state.totalUSDCSpentMicro / USDC_DECIMALS;
  const pnl = posSOL > 0 ? posValue - invested : 0;
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
  const done = isDCADoneToday(state);
  const paused = dcaAmountUSD === 0;
  const autoModeOn = state.walletMode === 'local' && state.autoExecute;

  return html`
    <div class="app">
      <header class="header">
        <div class="logo-row"><span class="logo">◎</span><span class="title">SOL DCA Bot</span></div>
        <button class="btn-chip" id="btnSetup">⚙ Wallet</button>
      </header>

      <!-- Statut wallet -->
      <div class="wallet-bar ${walletAddress ? 'wallet-ok' : 'wallet-missing'}">
        ${walletAddress
          ? html`<span>◉ ${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}</span>
                 ${autoModeOn ? '<span class="auto-badge">AUTO</span>' : ''}`
          : '<span>⚠ Aucun wallet configuré — configure d\'abord le wallet</span>'}
      </div>

      <!-- Prix -->
      <div class="card ${!priceData ? 'loading' : ''}">
        <div class="card-label">COURS SOL</div>
        ${priceData ? html`
          <div class="price-big">${fmtUSD(priceData.currentUSD)}</div>
          <div class="badge ${priceData.change30dPct >= 0 ? 'badge-green' : 'badge-red'}">
            ${fmtPct(priceData.change30dPct)} sur 30j
          </div>
          <div class="price-hint">
            ${paused
              ? '⏸ DCA suspendu — hausse > +20%'
              : dcaAmountUSD > state.baseAmountUSD
                ? `DCA renforcé : ${fmtUSD(dcaAmountUSD)}/jour`
                : `DCA normal : ${fmtUSD(dcaAmountUSD)}/jour`}
          </div>
        ` : '<div class="skeleton"></div>'}
      </div>

      <!-- Position -->
      <div class="card">
        <div class="card-label">MA POSITION</div>
        <div class="stat-row"><span>SOL accumulé</span><strong>${fmtSOL(state.totalSOLBoughtLamports)}</strong></div>
        <div class="stat-row"><span>Investi</span><strong>${fmtUSD(invested)}</strong></div>
        <div class="stat-row"><span>Prix moyen d'achat</span><strong>${state.averageBuyPriceUSD > 0 ? fmtUSD(state.averageBuyPriceUSD) : '—'}</strong></div>
        ${posSOL > 0 && priceData ? html`
          <div class="stat-row"><span>Valeur actuelle</span><strong>${fmtUSD(posValue)}</strong></div>
          <div class="stat-row"><span>P&L latent</span>
            <strong class="${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)} (${fmtPct(pnlPct)})</strong>
          </div>
        ` : ''}
      </div>

      <!-- Ordres de vente -->
      <div class="card">
        <div class="card-label">ORDRES DE VENTE ACTIFS</div>
        ${state.sellOrders.filter(o => o.status === 'active').length === 0
          ? '<div class="empty">Aucun ordre — ils apparaissent après le premier achat</div>'
          : state.sellOrders.filter(o => o.status === 'active').map(o => html`
              <div class="order-row">
                <div>
                  <span class="order-label">+${o.targetPct}% → ${fmtUSD(o.targetPriceUSD)}</span>
                  <span class="order-amount">${fmtSOL(o.solLamports)}</span>
                </div>
                <span class="badge badge-yellow">actif ✓</span>
              </div>`).join('')
        }
      </div>

      <!-- Action DCA -->
      <div class="card action-card">
        <div class="card-label">ACTION DCA</div>
        ${!walletAddress ? html`
          <p class="hint">Configure d'abord ton wallet.</p>
          <button class="btn btn-primary" id="btnGoSetup">Configurer le wallet</button>
        ` : paused ? html`
          <div class="badge badge-red">DCA suspendu — SOL en hausse > +20% sur 30j</div>
          <p class="hint">Le bot reprendra dès que le cours corrige.</p>
        ` : done ? html`
          <div class="badge badge-green">✓ DCA exécuté aujourd'hui</div>
          <p class="hint">Prochain achat demain.</p>
        ` : autoModeOn ? html`
          <p class="dca-amount">Achat automatique de <strong>${fmtUSD(dcaAmountUSD)}</strong></p>
          <button class="btn btn-primary ${isLoading ? 'loading' : ''}" id="btnDCA" ${isLoading ? 'disabled' : ''}>
            ${isLoading ? 'Transaction en cours…' : `▶ Exécuter maintenant — ${fmtUSD(dcaAmountUSD)}`}
          </button>
          <p class="hint-small">En mode AUTO, l'app exécute dès l'ouverture.</p>
        ` : html`
          <p class="dca-amount">Acheter <strong>${fmtUSD(dcaAmountUSD)}</strong> de SOL</p>
          <button class="btn btn-primary ${isLoading ? 'loading' : ''}" id="btnDCA" ${isLoading ? 'disabled' : ''}>
            ${isLoading ? 'Transaction en cours…' : `Exécuter le DCA — ${fmtUSD(dcaAmountUSD)}`}
          </button>
        `}
      </div>

      <!-- Historique -->
      ${state.dcaHistory.length > 0 ? html`
        <div class="card">
          <div class="card-label">HISTORIQUE DCA (${state.dcaHistory.length} achats)</div>
          ${[...state.dcaHistory].reverse().slice(0, 10).map(h => html`
            <div class="hist-row">
              <span class="hist-date">${h.date}</span>
              <span class="hist-details">
                ${fmtUSD(h.amountUSD)} → ${fmtSOL(h.solBoughtLamports)}
                <span class="hist-price">@ ${fmtUSD(h.solPriceUSD)}</span>
              </span>
            </div>`).join('')}
        </div>
      ` : ''}

      <!-- Paramètres -->
      <div class="card">
        <div class="card-label">PARAMÈTRES</div>
        <div class="setting-row">
          <label>Montant DCA de base (USD)</label>
          <input type="number" id="inputBase" value="${state.baseAmountUSD}" min="1" max="1000" step="1" />
        </div>
        <div class="setting-row">
          <label>RPC Solana</label>
          <input type="text" id="inputRPC" value="${state.rpcEndpoint}" placeholder="https://api.mainnet-beta.solana.com" />
        </div>
        <button class="btn btn-secondary" id="btnSaveSettings">Enregistrer</button>
        <button class="btn btn-danger" id="btnReset">Réinitialiser tout</button>
      </div>

      <footer class="footer">
        <button class="btn btn-ghost" id="btnRefresh">↻ Actualiser le prix</button>
        <span class="footer-note">Ordres de vente on-chain Jupiter • s'exécutent seuls 24h/24</span>
      </footer>
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
          Mets-y uniquement les USDC nécessaires. Ne pas utiliser le wallet principal.
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

  // main view
  on('btnSetup',        'click', () => { view = 'setup'; render(); });
  on('btnGoSetup',      'click', () => { view = 'setup'; render(); });
  on('btnDCA',          'click', () => { if (!isLoading) void handleDCA(); });
  on('btnRefresh',      'click', () => void refreshPrice().then(render));
  on('btnSaveSettings', 'click', () => {
    const base = parseFloat((document.getElementById('inputBase') as HTMLInputElement).value);
    const rpc  = (document.getElementById('inputRPC') as HTMLInputElement).value.trim();
    if (!isNaN(base) && base > 0) state.baseAmountUSD = base;
    if (rpc) state.rpcEndpoint = rpc;
    saveState(state);
    render();
  });
  on('btnReset', 'click', () => {
    if (confirm('Réinitialiser tout l\'historique et la position ? Irréversible.')) {
      state = resetState();
      render();
    }
  });
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
    const quote = await getSwapQuote(dcaAmountUSD);

    // 2. Swap tx
    const swapTx = await buildSwapTransaction(quote, pubkey);
    const swapSig = await signAndSendLocal(swapTx, keypair, state.rpcEndpoint);

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
      const cancelTx = await buildCancelOrdersTransaction(activeAccounts, pubkey);
      if (cancelTx) await signAndSendLocal(cancelTx, keypair, state.rpcEndpoint).catch(console.warn);
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
