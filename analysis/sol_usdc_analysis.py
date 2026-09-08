#!/usr/bin/env python3
"""Analyse technique SOL/USDC : structure, Fibonacci, order blocks, proposition d'ordre.

Cet outil recupere les bougies OHLC de SOL/USDC, en deduit la structure de
marche (tendance, swings), trace un retracement de Fibonacci sur la derniere
impulsion, repere les order blocks et les Fair Value Gaps pertinents, puis
propose eventuellement un ordre (entree, stop loss, take profit) avec un
ratio rendement/risque. Le tout est rendu dans un graphique sombre et lisible,
pense pour une lecture sur telephone.

Avertissement : il s'agit d'une aide a la decision heuristique et transparente,
pas d'un signal garanti. La methode "order blocks / Fibonacci" est
discretionnaire ; les niveaux sont a valider par votre propre jugement.

Usage :
    python3 sol_usdc_analysis.py --interval 1h
    python3 sol_usdc_analysis.py --interval 4h --limit 300 --out chart.png
    python3 sol_usdc_analysis.py --demo            # donnees synthetiques (hors-ligne)

Necessite un environnement avec acces reseau vers l'une des API :
    api.binance.com, data-api.binance.vision, api.kraken.com,
    api.exchange.coinbase.com
(voir analysis/README.md pour autoriser ces domaines).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

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
USER_AGENT = "sol-usdc-analysis/1.0"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --- Recuperation des donnees : plusieurs sources en cascade ------------------

def fetch_binance(interval: str, limit: int, host: str = "api.binance.com") -> pd.DataFrame:
    sym = "SOLUSDC"
    url = (f"https://{host}/api/v3/klines?symbol={sym}"
           f"&interval={INTERVAL_MAP[interval]['binance']}&limit={min(limit, 1000)}")
    raw = _get_json(url)
    rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
            for k in raw]
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.drop(columns="ts")


def fetch_kraken(interval: str, limit: int) -> pd.DataFrame:
    pair = "SOLUSD"
    url = (f"https://api.kraken.com/0/public/OHLC?pair={pair}"
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
    prod = "SOL-USDC"
    gran = INTERVAL_MAP[interval]["coinbase"]
    url = f"https://api.exchange.coinbase.com/products/{prod}/candles?granularity={gran}"
    raw = _get_json(url)  # [ time, low, high, open, close, volume ], recent first
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
            if len(df) >= 30:
                return df.reset_index(drop=True), name
            errors.append(f"{name}: seulement {len(df)} bougies")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    raise RuntimeError("Aucune source accessible.\n  - " + "\n  - ".join(errors))


def make_demo(interval: str, limit: int) -> tuple[pd.DataFrame, str]:
    """Genere une serie synthetique pour tester l'outil hors-ligne."""
    rng = np.random.default_rng(7)
    n = limit
    price = 150.0
    rows = []
    minutes = INTERVAL_MAP[interval]["minutes"]
    t0 = pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=minutes * n)
    trend = np.concatenate([np.linspace(0, 18, n // 2), np.linspace(18, 8, n - n // 2)])
    for i in range(n):
        drift = trend[i] - (trend[i - 1] if i else 0)
        o = price
        c = o + drift + rng.normal(0, 1.4)
        h = max(o, c) + abs(rng.normal(0, 0.9))
        l = min(o, c) - abs(rng.normal(0, 0.9))
        v = abs(rng.normal(1000, 300))
        rows.append((t0 + pd.Timedelta(minutes=minutes * i), o, h, l, c, v))
        price = c
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
    return df, "DEMO (donnees synthetiques)"


# --- Indicateurs et structure -------------------------------------------------

def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(period, min_periods=1).mean()


def swing_points(df: pd.DataFrame, left: int = 3, right: int = 3):
    """Detecte les swing highs/lows par fractales (pivots locaux)."""
    highs, lows = [], []
    h, l = df["high"].values, df["low"].values
    for i in range(left, len(df) - right):
        if h[i] == max(h[i - left:i + right + 1]) and h[i] > max(h[i - left:i]) if left else True:
            if h[i] >= h[i - left:i + right + 1].max():
                highs.append(i)
        if l[i] <= l[i - left:i + right + 1].min():
            lows.append(i)
    # deduplication de pivots colles
    highs = [i for k, i in enumerate(highs) if k == 0 or i - highs[k - 1] > right]
    lows = [i for k, i in enumerate(lows) if k == 0 or i - lows[k - 1] > right]
    return highs, lows


@dataclass
class OrderBlock:
    kind: str          # "bullish" | "bearish"
    idx: int
    low: float
    high: float
    time: pd.Timestamp


def find_order_blocks(df: pd.DataFrame, impulse_atr: float = 1.5) -> list[OrderBlock]:
    """Order block = derniere bougie de couleur opposee avant une impulsion.

    Bullish OB : derniere bougie baissiere avant une forte hausse.
    Bearish OB : derniere bougie haussiere avant une forte baisse.
    L'impulsion est jugee 'forte' si son amplitude depasse impulse_atr * ATR.
    """
    a = atr(df).values
    obs: list[OrderBlock] = []
    o, c, hi, lo = df["open"].values, df["close"].values, df["high"].values, df["low"].values
    for i in range(1, len(df) - 1):
        move = c[i + 1] - o[i + 1]
        if a[i] <= 0:
            continue
        if move > impulse_atr * a[i] and c[i] < o[i]:
            obs.append(OrderBlock("bullish", i, lo[i], hi[i], df["time"].iloc[i]))
        elif -move > impulse_atr * a[i] and c[i] > o[i]:
            obs.append(OrderBlock("bearish", i, lo[i], hi[i], df["time"].iloc[i]))
    return obs


@dataclass
class Analysis:
    interval: str
    source: str
    price: float
    trend: str
    swing_low: float
    swing_high: float
    fib: dict = field(default_factory=dict)
    bullish_ob: OrderBlock | None = None
    bearish_ob: OrderBlock | None = None
    proposal: dict | None = None
    notes: list[str] = field(default_factory=list)


def analyse(df: pd.DataFrame, interval: str, source: str) -> Analysis:
    df = df.copy()
    df["ema20"] = ema(df["close"], 20)
    df["ema50"] = ema(df["close"], 50)
    price = float(df["close"].iloc[-1])

    ema20, ema50 = df["ema20"].iloc[-1], df["ema50"].iloc[-1]
    if ema20 > ema50 and price > ema20:
        trend = "haussiere"
    elif ema20 < ema50 and price < ema20:
        trend = "baissiere"
    else:
        trend = "indecise"

    highs, lows = swing_points(df)
    lookback = min(len(df), 120)
    recent = set(range(len(df) - lookback, len(df)))
    r_highs = [i for i in highs if i in recent] or highs
    r_lows = [i for i in lows if i in recent] or lows

    # Derniere impulsion : dernier swing low et dernier swing high recents
    last_high_i = r_highs[-1] if r_highs else int(df["high"].idxmax())
    last_low_i = r_lows[-1] if r_lows else int(df["low"].idxmin())
    swing_high = float(df["high"].iloc[last_high_i])
    swing_low = float(df["low"].iloc[last_low_i])

    up_leg = last_high_i >= last_low_i  # impulsion haussiere si le sommet est posterieur au creux
    lo, hi = swing_low, swing_high
    ratios = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786]
    fib = {}
    for r in ratios:
        fib[r] = hi - (hi - lo) * r if up_leg else lo + (hi - lo) * r

    obs = find_order_blocks(df)
    bullish = [ob for ob in obs if ob.kind == "bullish" and ob.high <= price]
    bearish = [ob for ob in obs if ob.kind == "bearish" and ob.low >= price]
    bullish_ob = bullish[-1] if bullish else None
    bearish_ob = bearish[-1] if bearish else None

    an = Analysis(interval=interval, source=source, price=price, trend=trend,
                  swing_low=swing_low, swing_high=swing_high, fib=fib,
                  bullish_ob=bullish_ob, bearish_ob=bearish_ob)
    an.notes.append(f"Impulsion analysee : {'haussiere' if up_leg else 'baissiere'} "
                    f"de {lo:.2f} a {hi:.2f}.")
    an.proposal = build_proposal(an, up_leg, df)
    return an


def build_proposal(an: Analysis, up_leg: bool, df: pd.DataFrame) -> dict | None:
    """Construit une proposition d'ordre seulement si la configuration est nette.

    Regle de prudence : on n'entre que si le prix est proche d'une zone de
    confluence (golden pocket 0.618-0.705 et/ou order block) dans le sens de la
    tendance, et si le ratio rendement/risque est >= 1.5.
    """
    price = an.price
    a = float(atr(df).iloc[-1])
    gp_low = min(an.fib[0.618], an.fib[0.705])
    gp_high = max(an.fib[0.618], an.fib[0.705])
    in_gp = gp_low - a * 0.3 <= price <= gp_high + a * 0.3

    # LONG : tendance haussiere, prix dans le golden pocket et/ou sur un OB haussier
    if up_leg and an.trend == "haussiere":
        ob = an.bullish_ob
        near_ob = ob is not None and ob.low - a <= price <= ob.high + a
        if in_gp or near_ob:
            entry = price
            floor = min([v for v in [gp_low, ob.low if near_ob else None] if v is not None])
            stop = floor - a * 0.8
            target = an.swing_high  # retour vers le sommet de l'impulsion
            risk = entry - stop
            reward = target - entry
            if risk > 0 and reward / risk >= 1.5:
                return _order("LONG", entry, stop, target, reward / risk,
                              _long_reason(in_gp, near_ob, an))

    # SHORT : tendance baissiere, prix dans le golden pocket et/ou sur un OB baissier
    if (not up_leg) and an.trend == "baissiere":
        ob = an.bearish_ob
        near_ob = ob is not None and ob.low - a <= price <= ob.high + a
        if in_gp or near_ob:
            entry = price
            ceil = max([v for v in [gp_high, ob.high if near_ob else None] if v is not None])
            stop = ceil + a * 0.8
            target = an.swing_low
            risk = stop - entry
            reward = entry - target
            if risk > 0 and reward / risk >= 1.5:
                return _order("SHORT", entry, stop, target, reward / risk,
                              _short_reason(in_gp, near_ob, an))
    return None


def _order(side, entry, stop, target, rr, reason):
    return {"side": side, "entry": round(entry, 2), "stop": round(stop, 2),
            "target": round(target, 2), "rr": round(rr, 2), "reason": reason}


def _long_reason(in_gp, near_ob, an):
    parts = ["Tendance de fond haussiere (EMA20 > EMA50, prix au-dessus de l'EMA20)."]
    if in_gp:
        parts.append("Le prix a retrace dans le 'golden pocket' 0.618-0.705, "
                     "zone ou les impulsions haussieres reprennent souvent.")
    if near_ob:
        parts.append("Il teste un order block haussier (derniere bougie de vente "
                     "avant la derniere forte impulsion d'achat), une zone de demande.")
    parts.append("Stop place sous la zone pour invalider proprement si elle cede ; "
                 "objectif sur le dernier sommet de l'impulsion.")
    return " ".join(parts)


def _short_reason(in_gp, near_ob, an):
    parts = ["Tendance de fond baissiere (EMA20 < EMA50, prix sous l'EMA20)."]
    if in_gp:
        parts.append("Le prix est remonte dans le 'golden pocket' 0.618-0.705, "
                     "zone de rejet frequente en tendance baissiere.")
    if near_ob:
        parts.append("Il teste un order block baissier (derniere bougie d'achat "
                     "avant la derniere forte impulsion de vente), une zone d'offre.")
    parts.append("Stop place au-dessus de la zone ; objectif sur le dernier creux "
                 "de l'impulsion.")
    return " ".join(parts)


# --- Rendu graphique lisible sur telephone ------------------------------------

def render(df: pd.DataFrame, an: Analysis, out_path: str) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    plt.rcParams.update({
        "font.size": 13, "axes.edgecolor": "#444", "text.color": "#e8e8e8",
        "axes.labelcolor": "#e8e8e8", "xtick.color": "#bbb", "ytick.color": "#bbb",
    })
    df = df.tail(140).reset_index(drop=True)
    fig, (ax, axv) = plt.subplots(
        2, 1, figsize=(7.6, 11.0), dpi=150, sharex=True,
        gridspec_kw={"height_ratios": [4, 1], "hspace": 0.06})
    fig.patch.set_facecolor("#0e1116")
    for a_ in (ax, axv):
        a_.set_facecolor("#0e1116")
        a_.grid(color="#20262e", linewidth=0.6)

    x = np.arange(len(df))
    up = df["close"] >= df["open"]
    col_up, col_dn = "#26a69a", "#ef5350"
    # meches + corps
    ax.vlines(x, df["low"], df["high"], color=np.where(up, col_up, col_dn), linewidth=1)
    ax.bar(x[up], (df["close"] - df["open"])[up], bottom=df["open"][up],
           width=0.7, color=col_up)
    ax.bar(x[~up], (df["close"] - df["open"])[~up], bottom=df["open"][~up],
           width=0.7, color=col_dn)
    ax.plot(x, ema(df["close"], 20), color="#f4c430", linewidth=1.2, label="EMA20")
    ax.plot(x, ema(df["close"], 50), color="#8a7bff", linewidth=1.2, label="EMA50")

    xr = len(df) - 1
    # Fibonacci
    fib_colors = {0.236: "#7a7a7a", 0.382: "#5c9ded", 0.5: "#cccccc",
                  0.618: "#f4c430", 0.705: "#ffa64d", 0.786: "#9b59b6"}
    for r, lvl in an.fib.items():
        ax.axhline(lvl, color=fib_colors.get(r, "#888"), linewidth=1,
                   linestyle="--", alpha=0.8)
        ax.text(xr + 0.6, lvl, f"  {r:.3f}  {lvl:.2f}", va="center",
                fontsize=10, color=fib_colors.get(r, "#888"))
    # golden pocket ombre
    gp_lo, gp_hi = min(an.fib[0.618], an.fib[0.705]), max(an.fib[0.618], an.fib[0.705])
    ax.axhspan(gp_lo, gp_hi, color="#f4c430", alpha=0.08)

    # Order blocks
    def draw_ob(ob, color, label):
        if ob is None:
            return
        ax.add_patch(Rectangle((max(ob.idx - (len(df) - len(df)), 0), ob.low),
                               len(df), ob.high - ob.low, color=color, alpha=0.10))
        ax.text(1, ob.high, f" {label}", fontsize=9, color=color, va="bottom")
    draw_ob(an.bullish_ob, "#26a69a", "OB haussier")
    draw_ob(an.bearish_ob, "#ef5350", "OB baissier")

    # Proposition d'ordre
    p = an.proposal
    if p:
        ax.axhline(p["entry"], color="#ffffff", linewidth=1.4)
        ax.axhline(p["stop"], color="#ef5350", linewidth=1.4)
        ax.axhline(p["target"], color="#26a69a", linewidth=1.4)
        for lvl, txt, c in [(p["entry"], "ENTREE", "#ffffff"),
                            (p["stop"], "STOP", "#ef5350"),
                            (p["target"], "TP", "#26a69a")]:
            ax.text(0.5, lvl, f"{txt} {lvl:.2f}", fontsize=10, color=c,
                    va="center", fontweight="bold",
                    bbox=dict(boxstyle="round,pad=0.2", fc="#0e1116", ec=c))

    # Volume
    axv.bar(x[up], df["volume"][up], width=0.7, color=col_up, alpha=0.7)
    axv.bar(x[~up], df["volume"][~up], width=0.7, color=col_dn, alpha=0.7)
    axv.set_ylabel("Vol", fontsize=10)

    # Titre / axes
    ts = df["time"].iloc[-1].strftime("%Y-%m-%d %H:%M UTC")
    head = (f"SOL/USDC  |  {an.interval}  |  {an.price:.2f}  |  tendance {an.trend}\n"
            f"{an.source}  |  {ts}")
    ax.set_title(head, color="#e8e8e8", fontsize=14, loc="left", pad=12)
    ax.legend(loc="upper left", facecolor="#0e1116", edgecolor="#444", fontsize=10)
    ax.set_xlim(-1, len(df) + 12)
    step = max(1, len(df) // 6)
    axv.set_xticks(x[::step])
    axv.set_xticklabels([df["time"].iloc[i].strftime("%m-%d %H:%M") for i in x[::step]],
                        rotation=0, fontsize=9)
    fig.savefig(out_path, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


# --- Sortie texte -------------------------------------------------------------

def print_report(an: Analysis) -> None:
    print("=" * 60)
    print(f"ANALYSE SOL/USDC  -  {an.interval}  -  {an.source}")
    print("=" * 60)
    print(f"Prix actuel      : {an.price:.2f}")
    print(f"Tendance         : {an.trend}")
    print(f"Swing bas / haut : {an.swing_low:.2f} / {an.swing_high:.2f}")
    print("Niveaux Fibonacci :")
    for r, lvl in an.fib.items():
        tag = "  <- golden pocket" if r in (0.618, 0.705) else ""
        print(f"   {r:.3f} : {lvl:.2f}{tag}")
    if an.bullish_ob:
        print(f"Order block haussier : {an.bullish_ob.low:.2f} - {an.bullish_ob.high:.2f}")
    if an.bearish_ob:
        print(f"Order block baissier : {an.bearish_ob.low:.2f} - {an.bearish_ob.high:.2f}")
    print("-" * 60)
    p = an.proposal
    if p:
        print(f"PROPOSITION : {p['side']}")
        print(f"   Entree : {p['entry']}   Stop : {p['stop']}   TP : {p['target']}")
        print(f"   Ratio rendement/risque : {p['rr']}")
        print(f"   Raison : {p['reason']}")
    else:
        print("AUCUN ORDRE PROPOSE.")
        print("   Le prix n'est sur aucune zone de confluence nette dans le sens")
        print("   de la tendance, ou le ratio rendement/risque serait insuffisant.")
        print("   Rester a l'ecart et attendre un meilleur point d'entree.")
    print("=" * 60)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Analyse technique SOL/USDC")
    ap.add_argument("--interval", default="1h", choices=list(INTERVAL_MAP))
    ap.add_argument("--limit", type=int, default=300)
    ap.add_argument("--out", default="sol_usdc_chart.png")
    ap.add_argument("--demo", action="store_true",
                    help="donnees synthetiques, sans reseau")
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
