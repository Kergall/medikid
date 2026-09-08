#!/usr/bin/env python3
"""Analyse technique SOL/USDC facon "smart money" (methodologie ICT).

Cet outil recupere les bougies OHLC de SOL/USDC et applique une lecture
smart money deterministe et transparente :

  - Structure de marche : BOS (cassure de structure) et CHoCH (changement de
    caractere), pour dater les continuations et les retournements.
  - OTE (Optimal Trade Entry) : zone de retracement 0.62-0.79 de la derniere
    impulsion, avec 0.705 comme point optimal.
  - Fair Value Gaps / imbalances : desequilibres laisses par une impulsion.
  - Zones de liquidite : liquidite acheteuse au-dessus (BSL) et vendeuse en
    dessous (SSL), la ou se logent les stops.
  - Order blocks : derniere bougie opposee avant une forte impulsion.
  - MACD : confirmation du momentum.
  - EMA 20/50 : contexte de tendance.

Il propose eventuellement un ordre (entree, stop, take profit) UNIQUEMENT en
cas de confluence nette (OTE + FVG/OB + structure alignee) et si le ratio
rendement/risque est suffisant. Sinon il indique qu'aucun ordre n'est justifie.
Le graphique est rendu en portrait, fond sombre, pour une lecture sur telephone.

> Avertissement. Aide heuristique et transparente, pas un signal garanti. La
> methodologie ICT est discretionnaire ; empiler des indicateurs n'ajoute pas
> de certitude. Validez toujours par votre propre jugement et ne risquez que ce
> que vous pouvez perdre.

Usage :
    python3 sol_usdc_analysis.py --interval 1h
    python3 sol_usdc_analysis.py --interval 4h --limit 400 --out chart.png
    python3 sol_usdc_analysis.py --demo            # donnees synthetiques (hors-ligne)
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

# --- Correspondance des intervalles entre les differentes API -----------------

INTERVAL_MAP = {
    "5m":  {"binance": "5m",  "kraken": 5,    "coinbase": 300,   "minutes": 5},
    "15m": {"binance": "15m", "kraken": 15,   "coinbase": 900,   "minutes": 15},
    "1h":  {"binance": "1h",  "kraken": 60,   "coinbase": 3600,  "minutes": 60},
    "4h":  {"binance": "4h",  "kraken": 240,  "coinbase": 21600, "minutes": 240},
    "1d":  {"binance": "1d",  "kraken": 1440, "coinbase": 86400, "minutes": 1440},
}

HTTP_TIMEOUT = 20
USER_AGENT = "sol-usdc-analysis/2.0"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --- Recuperation des donnees : plusieurs sources en cascade ------------------

def fetch_binance(interval: str, limit: int, host: str = "api.binance.com") -> pd.DataFrame:
    url = (f"https://{host}/api/v3/klines?symbol=SOLUSDC"
           f"&interval={INTERVAL_MAP[interval]['binance']}&limit={min(limit, 1000)}")
    raw = _get_json(url)
    rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
            for k in raw]
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.drop(columns="ts")


def fetch_kraken(interval: str, limit: int) -> pd.DataFrame:
    url = (f"https://api.kraken.com/0/public/OHLC?pair=SOLUSD"
           f"&interval={INTERVAL_MAP[interval]['kraken']}")
    raw = _get_json(url)
    if raw.get("error"):
        raise RuntimeError(f"Kraken: {raw['error']}")
    key = next(k for k in raw["result"] if k != "last")
    rows = [(int(r[0]) * 1000, float(r[1]), float(r[2]), float(r[3]),
             float(r[4]), float(r[6])) for r in raw["result"][key]]
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.drop(columns="ts").tail(limit).reset_index(drop=True)


def fetch_coinbase(interval: str, limit: int) -> pd.DataFrame:
    gran = INTERVAL_MAP[interval]["coinbase"]
    url = f"https://api.exchange.coinbase.com/products/SOL-USDC/candles?granularity={gran}"
    raw = _get_json(url)  # [ time, low, high, open, close, volume ], recent d'abord
    rows = [(int(c[0]) * 1000, float(c[3]), float(c[2]), float(c[1]),
             float(c[4]), float(c[5])) for c in raw]
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.sort_values("time").drop(columns="ts").tail(limit).reset_index(drop=True)


def fetch_ohlc(interval: str, limit: int) -> tuple[pd.DataFrame, str]:
    sources = [
        ("Binance SOL/USDC", lambda: fetch_binance(interval, limit)),
        ("Binance Vision SOL/USDC", lambda: fetch_binance(interval, limit, "data-api.binance.vision")),
        ("Kraken SOL/USD", lambda: fetch_kraken(interval, limit)),
        ("Coinbase SOL/USDC", lambda: fetch_coinbase(interval, limit)),
    ]
    errors = []
    for name, fn in sources:
        try:
            df = fn()
            if len(df) >= 60:
                return df.reset_index(drop=True), name
            errors.append(f"{name}: seulement {len(df)} bougies")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    raise RuntimeError("Aucune source accessible.\n  - " + "\n  - ".join(errors))


def make_demo(interval: str, limit: int) -> tuple[pd.DataFrame, str]:
    """Serie synthetique pour tester l'outil hors-ligne."""
    rng = np.random.default_rng(11)
    n = max(limit, 160)
    minutes = INTERVAL_MAP[interval]["minutes"]
    t0 = pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=minutes * n)
    # tendance : hausse, repli, reprise (pour exercer BOS/CHoCH/OTE)
    seg = n // 3
    trend = np.concatenate([
        np.linspace(0, 22, seg),
        np.linspace(22, 9, seg),
        np.linspace(9, 30, n - 2 * seg),
    ])
    rows, price = [], 150.0
    for i in range(n):
        drift = trend[i] - (trend[i - 1] if i else 0)
        o = price
        c = o + drift + rng.normal(0, 1.5)
        h = max(o, c) + abs(rng.normal(0, 1.0))
        l = min(o, c) - abs(rng.normal(0, 1.0))
        rows.append((t0 + pd.Timedelta(minutes=minutes * i), o, h, l, c,
                     abs(rng.normal(1000, 300))))
        price = c
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
    return df, "DEMO (donnees synthetiques)"


# --- Indicateurs --------------------------------------------------------------

def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - prev).abs(),
                    (df["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(period, min_periods=1).mean()


def macd(series: pd.Series, fast=12, slow=26, signal=9):
    line = ema(series, fast) - ema(series, slow)
    sig = line.ewm(span=signal, adjust=False).mean()
    return line, sig, line - sig


# --- Pivots et structure de marche (BOS / CHoCH) ------------------------------

def swing_pivots(df: pd.DataFrame, left: int = 3, right: int = 3):
    """Pivots fractals. Retourne une liste (idx, 'H'|'L', prix) triee par idx."""
    h, l = df["high"].values, df["low"].values
    piv = []
    for i in range(left, len(df) - right):
        win_h = h[i - left:i + right + 1]
        win_l = l[i - left:i + right + 1]
        if h[i] == win_h.max() and (win_h == h[i]).sum() == 1:
            piv.append((i, "H", float(h[i])))
        if l[i] == win_l.min() and (win_l == l[i]).sum() == 1:
            piv.append((i, "L", float(l[i])))
    piv.sort(key=lambda p: p[0])
    return piv


@dataclass
class StructEvent:
    idx: int
    kind: str      # BOS_up | BOS_down | CHoCH_up | CHoCH_down
    level: float


def market_structure(df: pd.DataFrame, pivots, right: int = 3):
    """Detecte BOS et CHoCH par cassure en cloture d'un pivot de reference.

    Un BOS est une cassure dans le sens de la tendance en cours (continuation) ;
    un CHoCH est la premiere cassure en sens contraire (retournement).
    """
    conf: dict[int, list] = {}
    for (idx, typ, price) in pivots:
        conf.setdefault(idx + right, []).append((typ, idx, price))

    close = df["close"].values
    ref_high = ref_low = None      # (idx, prix) du dernier pivot confirme
    trend = 0
    events: list[StructEvent] = []
    for bar in range(len(df)):
        c = close[bar]
        if ref_high is not None and c > ref_high[1]:
            kind = "BOS_up" if trend == 1 else "CHoCH_up"
            events.append(StructEvent(bar, kind, ref_high[1]))
            trend, ref_high = 1, None
        elif ref_low is not None and c < ref_low[1]:
            kind = "BOS_down" if trend == -1 else "CHoCH_down"
            events.append(StructEvent(bar, kind, ref_low[1]))
            trend, ref_low = -1, None
        for (typ, idx, price) in conf.get(bar, []):
            if typ == "H":
                ref_high = (idx, price)
            else:
                ref_low = (idx, price)
    return events, trend


# --- Fair Value Gaps / imbalances ---------------------------------------------

@dataclass
class FVG:
    kind: str      # bull | bear
    idx: int
    bot: float
    top: float
    filled: bool


def find_fvgs(df: pd.DataFrame) -> list[FVG]:
    h, l = df["high"].values, df["low"].values
    out: list[FVG] = []
    n = len(df)
    # Seuil anti-bruit : on ignore les gaps negligeables (bruit de meche)
    min_gap = 0.12 * float(np.median(h - l))
    for i in range(n - 2):
        if l[i + 2] > h[i]:                       # bullish imbalance
            bot, top = h[i], l[i + 2]
            if top - bot < min_gap:
                continue
            filled = bool((l[i + 3:] <= bot).any()) if i + 3 < n else False
            out.append(FVG("bull", i + 1, bot, top, filled))
        elif h[i + 2] < l[i]:                      # bearish imbalance
            bot, top = h[i + 2], l[i]
            if top - bot < min_gap:
                continue
            filled = bool((h[i + 3:] >= top).any()) if i + 3 < n else False
            out.append(FVG("bear", i + 1, bot, top, filled))
    return out


# --- Order blocks -------------------------------------------------------------

@dataclass
class OrderBlock:
    kind: str      # bullish | bearish
    idx: int
    low: float
    high: float


def find_order_blocks(df: pd.DataFrame, impulse_atr: float = 1.5) -> list[OrderBlock]:
    a = atr(df).values
    o, c, hi, lo = (df[k].values for k in ("open", "close", "high", "low"))
    obs: list[OrderBlock] = []
    for i in range(1, len(df) - 1):
        if a[i] <= 0:
            continue
        move = c[i + 1] - o[i + 1]
        if move > impulse_atr * a[i] and c[i] < o[i]:
            obs.append(OrderBlock("bullish", i, float(lo[i]), float(hi[i])))
        elif -move > impulse_atr * a[i] and c[i] > o[i]:
            obs.append(OrderBlock("bearish", i, float(lo[i]), float(hi[i])))
    return obs


# --- Assemblage de l'analyse --------------------------------------------------

@dataclass
class Analysis:
    interval: str
    source: str
    price: float
    trend_txt: str
    bias: int                       # 1 haussier, -1 baissier, 0 neutre
    up_leg: bool
    swing_low: float
    swing_high: float
    fib: dict
    ote: tuple                      # (bas, haut, point_optimal_0705)
    events: list
    fvgs: list
    obs: list
    bsl: Optional[float]            # liquidite acheteuse (au-dessus)
    ssl: Optional[float]            # liquidite vendeuse (en dessous)
    macd_txt: str
    proposal: Optional[dict]
    notes: list = field(default_factory=list)


def analyse(df: pd.DataFrame, interval: str, source: str) -> Analysis:
    df = df.copy().reset_index(drop=True)
    df["ema20"] = ema(df["close"], 20)
    df["ema50"] = ema(df["close"], 50)
    price = float(df["close"].iloc[-1])
    a = float(atr(df).iloc[-1])

    pivots = swing_pivots(df)
    events, struct_trend = market_structure(df, pivots)

    # Biais : structure d'abord, EMA en confirmation
    ema_bias = 1 if df["ema20"].iloc[-1] > df["ema50"].iloc[-1] else -1
    bias = struct_trend if struct_trend != 0 else ema_bias
    trend_txt = {1: "haussiere", -1: "baissiere", 0: "indecise"}[bias]
    if struct_trend != 0 and struct_trend != ema_bias:
        trend_txt += " (structure et EMA divergent : prudence)"

    # Derniere impulsion pour Fibonacci / OTE
    highs = [p for p in pivots if p[1] == "H"]
    lows = [p for p in pivots if p[1] == "L"]
    last_h = highs[-1] if highs else (int(df["high"].idxmax()), "H", float(df["high"].max()))
    last_l = lows[-1] if lows else (int(df["low"].idxmin()), "L", float(df["low"].min()))
    swing_high, swing_low = last_h[2], last_l[2]
    up_leg = last_h[0] >= last_l[0]

    lo, hi = swing_low, swing_high
    ratios = [0.5, 0.618, 0.705, 0.786]
    fib = {r: (hi - (hi - lo) * r if up_leg else lo + (hi - lo) * r) for r in ratios}
    r_lo, r_hi = (0.62, 0.79)
    ote_a = hi - (hi - lo) * r_lo if up_leg else lo + (hi - lo) * r_lo
    ote_b = hi - (hi - lo) * r_hi if up_leg else lo + (hi - lo) * r_hi
    ote_opt = hi - (hi - lo) * 0.705 if up_leg else lo + (hi - lo) * 0.705
    ote = (min(ote_a, ote_b), max(ote_a, ote_b), ote_opt)

    fvgs = find_fvgs(df)
    obs = find_order_blocks(df)

    # Liquidite : pivot haut le plus proche au-dessus, pivot bas le plus proche en dessous
    bsl = min([p[2] for p in highs if p[2] > price], default=None)
    ssl = max([p[2] for p in lows if p[2] < price], default=None)

    macd_line, macd_sig, macd_hist = macd(df["close"])
    hist_last = float(macd_hist.iloc[-1])
    rising = macd_hist.iloc[-1] > macd_hist.iloc[-2]
    macd_txt = (f"{'positif' if hist_last >= 0 else 'negatif'}, "
                f"momentum {'en hausse' if rising else 'en baisse'}")

    an = Analysis(interval, source, price, trend_txt, bias, up_leg, swing_low,
                  swing_high, fib, ote, events, fvgs, obs, bsl, ssl, macd_txt, None)
    an.notes.append(
        f"Impulsion analysee : {'haussiere' if up_leg else 'baissiere'} "
        f"de {lo:.2f} a {hi:.2f}.")
    if events:
        last = events[-1]
        an.notes.append(f"Dernier evenement de structure : {last.kind} "
                        f"au niveau {last.level:.2f}.")
    an.proposal = build_proposal(an, df, a, hist_last)
    return an


def _overlap(a_lo, a_hi, b_lo, b_hi) -> bool:
    return a_lo <= b_hi and b_lo <= a_hi


def build_proposal(an: Analysis, df: pd.DataFrame, a: float, hist: float) -> Optional[dict]:
    """Propose un ordre en cas de confluence nette OTE + FVG/OB + structure.

    - Sens dicte par le biais de structure.
    - Entree exigee dans la zone OTE (0.62-0.79).
    - Confluence requise : un FVG et/ou un order block non mitige dans le sens
      du trade, chevauchant la zone d'entree.
    - Objectif : la liquidite opposee la plus proche.
    - Ratio rendement/risque minimal : 1.5.
    """
    price = an.price
    ote_lo, ote_hi, ote_opt = an.ote
    buf = a * 0.3
    in_ote = ote_lo - buf <= price <= ote_hi + buf

    if an.bias == 1 and an.up_leg and in_ote:
        fvg = next((f for f in reversed(an.fvgs)
                    if f.kind == "bull" and not f.filled
                    and _overlap(f.bot, f.top, ote_lo, ote_hi)), None)
        ob = next((o for o in reversed(an.obs)
                   if o.kind == "bullish" and _overlap(o.low, o.high, ote_lo, ote_hi)), None)
        if fvg or ob:
            entry = price
            floor = min([v for v in [ote_hi, an.swing_low,
                                     fvg.bot if fvg else None,
                                     ob.low if ob else None] if v is not None])
            stop = floor - a * 0.7
            target = an.bsl if an.bsl and an.bsl > entry else an.swing_high
            risk, reward = entry - stop, target - entry
            if risk > 0 and reward / risk >= 1.5:
                return _order("LONG", entry, stop, target, reward / risk,
                              _reason(True, fvg, ob, an, hist))

    if an.bias == -1 and not an.up_leg and in_ote:
        fvg = next((f for f in reversed(an.fvgs)
                    if f.kind == "bear" and not f.filled
                    and _overlap(f.bot, f.top, ote_lo, ote_hi)), None)
        ob = next((o for o in reversed(an.obs)
                   if o.kind == "bearish" and _overlap(o.low, o.high, ote_lo, ote_hi)), None)
        if fvg or ob:
            entry = price
            ceil = max([v for v in [ote_lo, an.swing_high,
                                    fvg.top if fvg else None,
                                    ob.high if ob else None] if v is not None])
            stop = ceil + a * 0.7
            target = an.ssl if an.ssl and an.ssl < entry else an.swing_low
            risk, reward = stop - entry, entry - target
            if risk > 0 and reward / risk >= 1.5:
                return _order("SHORT", entry, stop, target, reward / risk,
                              _reason(False, fvg, ob, an, hist))
    return None


def _order(side, entry, stop, target, rr, reason):
    return {"side": side, "entry": round(entry, 2), "stop": round(stop, 2),
            "target": round(target, 2), "rr": round(rr, 2), "reason": reason}


def _reason(is_long, fvg, ob, an, hist) -> str:
    d = "haussiere" if is_long else "baissiere"
    parts = [f"Structure {d} (dernier evenement : "
             f"{an.events[-1].kind if an.events else 'n/d'})."]
    parts.append("Le prix est dans la zone OTE (0.62-0.79), zone d'entree "
                 "optimale de la methodologie ICT, autour du 0.705.")
    if fvg:
        parts.append("Un Fair Value Gap (imbalance) non comble coincide avec "
                     "cette zone : le marche tend a revenir combler ce "
                     "desequilibre avant de repartir.")
    if ob:
        parts.append("Un order block du meme sens renforce la zone "
                     "(derniere bougie opposee avant l'impulsion).")
    liq = an.bsl if is_long else an.ssl
    if liq:
        parts.append(f"Objectif fixe sur la liquidite opposee la plus proche "
                     f"({'au-dessus' if is_long else 'en dessous'}, {liq:.2f}).")
    macd_ok = (hist >= 0) == is_long
    parts.append(f"MACD {'confirme' if macd_ok else 'ne confirme pas encore'} "
                 f"le momentum ({an.macd_txt}).")
    parts.append("Stop place juste au-dela de la zone : si elle cede, le "
                 "scenario est invalide proprement.")
    return " ".join(parts)


# --- Rendu graphique lisible sur telephone ------------------------------------

def render(df_full: pd.DataFrame, an: Analysis, out_path: str, view: int = 130) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    plt.rcParams.update({
        "font.size": 12.5, "axes.edgecolor": "#444", "text.color": "#e8e8e8",
        "axes.labelcolor": "#e8e8e8", "xtick.color": "#bbb", "ytick.color": "#bbb",
    })
    n_full = len(df_full)
    off = max(0, n_full - view)
    df = df_full.iloc[off:].reset_index(drop=True)
    ml, ms, mh = macd(df_full["close"])
    ml, ms, mh = ml.iloc[off:].values, ms.iloc[off:].values, mh.iloc[off:].values

    fig, (ax, axm, axv) = plt.subplots(
        3, 1, figsize=(7.8, 13.2), dpi=150, sharex=True,
        gridspec_kw={"height_ratios": [4.2, 1.1, 0.9], "hspace": 0.05})
    fig.patch.set_facecolor("#0e1116")
    for a_ in (ax, axm, axv):
        a_.set_facecolor("#0e1116")
        a_.grid(color="#20262e", linewidth=0.6)

    x = np.arange(len(df))
    up = df["close"].values >= df["open"].values
    cu, cd = "#26a69a", "#ef5350"
    colors = np.where(up, cu, cd)
    ax.vlines(x, df["low"], df["high"], color=colors, linewidth=1)
    ax.bar(x[up], (df["close"] - df["open"]).values[up], bottom=df["open"].values[up],
           width=0.7, color=cu)
    ax.bar(x[~up], (df["close"] - df["open"]).values[~up], bottom=df["open"].values[~up],
           width=0.7, color=cd)
    ax.plot(x, ema(df["close"], 20), color="#f4c430", linewidth=1.2, label="EMA20")
    ax.plot(x, ema(df["close"], 50), color="#8a7bff", linewidth=1.2, label="EMA50")
    xr = len(df) - 1

    def vis(idx):
        """idx absolu -> x visible, ou None si hors fenetre."""
        return idx - off if idx >= off else None

    # Zone OTE + point optimal 0.705
    ote_lo, ote_hi, ote_opt = an.ote
    ax.axhspan(ote_lo, ote_hi, color="#f4c430", alpha=0.10)
    ax.axhline(ote_opt, color="#f4c430", linewidth=1.1, linestyle="--", alpha=0.9)
    ax.text(xr + 0.6, ote_opt, f"  OTE .705 {ote_opt:.2f}", va="center",
            fontsize=9.5, color="#f4c430")

    # Bornes verticales : les bougies visibles (evite qu'un element lointain
    # n'etire l'axe et ne laisse un grand vide sur mobile)
    vlo, vhi = float(df["low"].min()), float(df["high"].max())

    # Fair Value Gaps non combles, visibles dans la fenetre de prix (2 plus proches)
    price = an.price
    fresh = [f for f in an.fvgs if not f.filled and f.top >= vlo and f.bot <= vhi]
    fresh.sort(key=lambda f: abs((f.bot + f.top) / 2 - price))
    for f in fresh[:2]:
        col = "#1f6f66" if f.kind == "bull" else "#7a2f2f"
        vx = vis(f.idx)
        x0 = vx if vx is not None else 0
        ax.add_patch(Rectangle((x0, f.bot), len(df) - x0, f.top - f.bot,
                               color=col, alpha=0.22))
        ax.text(x0 + 0.5, (f.bot + f.top) / 2, " FVG", fontsize=8.5,
                color="#d0d0d0", va="center")

    # Order block dans le sens du biais (le plus proche du prix)
    want = "bullish" if an.bias == 1 else "bearish"
    cand = [o for o in an.obs if o.kind == want]
    cand.sort(key=lambda o: abs((o.low + o.high) / 2 - price))
    if cand:
        o = cand[0]
        col = "#26a69a" if want == "bullish" else "#ef5350"
        vx = vis(o.idx)
        x0 = vx if vx is not None else 0
        ax.add_patch(Rectangle((x0, o.low), len(df) - x0, o.high - o.low,
                               color=col, alpha=0.10))
        ax.text(x0 + 0.5, o.high, f" OB {want}", fontsize=8.5, color=col, va="bottom")

    # Liquidite BSL / SSL
    if an.bsl:
        ax.axhline(an.bsl, color="#5c9ded", linewidth=1, linestyle=":")
        ax.text(0.5, an.bsl, f"BSL liquidite {an.bsl:.2f}", fontsize=9,
                color="#5c9ded", va="bottom")
    if an.ssl:
        ax.axhline(an.ssl, color="#5c9ded", linewidth=1, linestyle=":")
        ax.text(0.5, an.ssl, f"SSL liquidite {an.ssl:.2f}", fontsize=9,
                color="#5c9ded", va="top")

    # Evenements de structure : le dernier CHoCH et le dernier BOS seulement
    last_choch = next((e for e in reversed(an.events) if e.kind.startswith("CHoCH")), None)
    last_bos = next((e for e in reversed(an.events) if e.kind.startswith("BOS")), None)
    for ev in [e for e in (last_choch, last_bos) if e is not None]:
        vx = vis(ev.idx)
        if vx is None:
            continue
        col = "#26a69a" if ev.kind.endswith("up") else "#ef5350"
        label = "CHoCH" if ev.kind.startswith("CHoCH") else "BOS"
        ax.hlines(ev.level, max(0, vx - 6), min(xr, vx + 2), color=col, linewidth=1.2)
        ax.text(vx, ev.level, f" {label}", fontsize=9, color=col,
                va="bottom", fontweight="bold")

    # Proposition d'ordre
    p = an.proposal
    if p:
        for lvl, txt, c in [(p["entry"], "ENTREE", "#ffffff"),
                            (p["stop"], "STOP", "#ef5350"),
                            (p["target"], "TP", "#26a69a")]:
            ax.axhline(lvl, color=c, linewidth=1.4)
            ax.text(0.5, lvl, f"{txt} {lvl:.2f}", fontsize=10, color=c,
                    va="center", fontweight="bold",
                    bbox=dict(boxstyle="round,pad=0.2", fc="#0e1116", ec=c))

    # MACD
    axm.axhline(0, color="#555", linewidth=0.7)
    axm.bar(x, mh, width=0.7, color=np.where(mh >= 0, cu, cd), alpha=0.7)
    axm.plot(x, ml, color="#5c9ded", linewidth=1, label="MACD")
    axm.plot(x, ms, color="#f4c430", linewidth=1, label="signal")
    axm.legend(loc="upper left", facecolor="#0e1116", edgecolor="#444", fontsize=8)
    axm.set_ylabel("MACD", fontsize=9)

    # Volume
    axv.bar(x[up], df["volume"].values[up], width=0.7, color=cu, alpha=0.7)
    axv.bar(x[~up], df["volume"].values[~up], width=0.7, color=cd, alpha=0.7)
    axv.set_ylabel("Vol", fontsize=9)

    ts = df["time"].iloc[-1].strftime("%Y-%m-%d %H:%M UTC")
    ax.set_title(f"SOL/USDC  |  {an.interval}  |  {an.price:.2f}  |  {an.trend_txt}\n"
                 f"{an.source}  |  {ts}", color="#e8e8e8", fontsize=13.5,
                 loc="left", pad=12)
    ax.legend(loc="upper left", facecolor="#0e1116", edgecolor="#444", fontsize=9)
    # Bornes Y : bougies visibles + niveaux pertinents (OTE, liquidite, ordre)
    ys = [vlo, vhi, ote_lo, ote_hi]
    ys += [v for v in (an.bsl, an.ssl) if v is not None]
    if p:
        ys += [p["entry"], p["stop"], p["target"]]
    y_lo, y_hi = min(ys), max(ys)
    pad = (y_hi - y_lo) * 0.06
    ax.set_ylim(y_lo - pad, y_hi + pad)
    ax.set_xlim(-1, len(df) + 13)
    step = max(1, len(df) // 6)
    axv.set_xticks(x[::step])
    axv.set_xticklabels([df["time"].iloc[i].strftime("%m-%d %H:%M") for i in x[::step]],
                        fontsize=9)
    fig.savefig(out_path, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


# --- Sortie texte -------------------------------------------------------------

def print_report(an: Analysis) -> None:
    print("=" * 62)
    print(f"ANALYSE SOL/USDC  -  {an.interval}  -  {an.source}")
    print("=" * 62)
    print(f"Prix actuel      : {an.price:.2f}")
    print(f"Biais / tendance : {an.trend_txt}")
    print(f"Swing bas / haut : {an.swing_low:.2f} / {an.swing_high:.2f}")
    print(f"MACD             : {an.macd_txt}")
    if an.events:
        seq = ", ".join(f"{e.kind}@{e.level:.2f}" for e in an.events[-3:])
        print(f"Structure        : {seq}")
    ote_lo, ote_hi, ote_opt = an.ote
    print(f"Zone OTE (0.62-0.79) : {ote_lo:.2f} - {ote_hi:.2f}  (optimal 0.705 : {ote_opt:.2f})")
    fresh = [f for f in an.fvgs if not f.filled]
    if fresh:
        near = sorted(fresh, key=lambda f: abs((f.bot + f.top) / 2 - an.price))[:2]
        print("FVG non combles  : " +
              "; ".join(f"{f.kind} {f.bot:.2f}-{f.top:.2f}" for f in near))
    if an.bsl:
        print(f"Liquidite BSL (au-dessus) : {an.bsl:.2f}")
    if an.ssl:
        print(f"Liquidite SSL (en dessous): {an.ssl:.2f}")
    print("-" * 62)
    p = an.proposal
    if p:
        print(f"PROPOSITION : {p['side']}")
        print(f"   Entree : {p['entry']}   Stop : {p['stop']}   TP : {p['target']}")
        print(f"   Ratio rendement/risque : {p['rr']}")
        print(f"   Raison : {p['reason']}")
    else:
        print("AUCUN ORDRE PROPOSE.")
        print("   Pas de confluence nette (OTE + FVG/order block + structure")
        print("   alignee) au prix actuel, ou ratio rendement/risque insuffisant.")
        print("   Rester a l'ecart et attendre un meilleur point d'entree.")
    print("=" * 62)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Analyse technique SOL/USDC (ICT)")
    ap.add_argument("--interval", default="1h", choices=list(INTERVAL_MAP))
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--out", default="sol_usdc_chart.png")
    ap.add_argument("--demo", action="store_true", help="donnees synthetiques, sans reseau")
    args = ap.parse_args(argv)

    try:
        df, source = (make_demo if args.demo else fetch_ohlc)(args.interval, args.limit)
    except Exception as exc:  # noqa: BLE001
        print(f"ERREUR : impossible de recuperer les donnees.\n{exc}", file=sys.stderr)
        print("\nCet environnement autorise-t-il bien une API de cotation ?"
              "\nVoir analysis/README.md.", file=sys.stderr)
        return 2

    an = analyse(df, args.interval, source)
    render(df, an, args.out)
    print_report(an)
    print(f"\nGraphique enregistre : {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
