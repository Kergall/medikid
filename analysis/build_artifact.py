#!/usr/bin/env python3
"""Genere le terminal ICT multi-paires (SOL/BTC/ETH x 1m..4h) en HTML autonome.

Recupere les bougies reelles Binance, applique l'analyse ICT de
sol_usdc_analysis.py (source de verite), injecte le tout dans le gabarit
terminal_template.html et ecrit terminal_build.html a cote.

Concu pour tourner sans reseau de rendu (pas de matplotlib) : seules pandas et
numpy sont requises, en plus du module d'analyse.

Usage :
    python3 analysis/build_artifact.py            # ecrit analysis/terminal_build.html
    python3 analysis/build_artifact.py /chemin/sortie.html
"""
import json, sys, io, contextlib, datetime, os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pandas as pd
import sol_usdc_analysis as S

VIEW = 130
LIMIT = 400
PAIRS = {"SOL": "SOLUSDC", "BTC": "BTCUSDC", "ETH": "ETHUSDC"}
INTERVALS = ["1m", "5m", "15m", "1h", "4h"]
TEMPLATE = os.path.join(HERE, "terminal_template.html")


def fetch(symbol, interval):
    """(df, source) via Binance (hote Vision puis public)."""
    last = None
    for host in ("data-api.binance.vision", "api.binance.com"):
        try:
            url = (f"https://{host}/api/v3/klines?symbol={symbol}"
                   f"&interval={interval}&limit={min(LIMIT, 1000)}")
            raw = S._get_json(url)
            if not raw:
                raise RuntimeError("reponse vide")
            rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
                    for k in raw]
            df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
            df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
            return df.drop(columns="ts"), f"Binance {host} {symbol[:-4]}/USDC"
        except Exception as e:
            last = e
    raise RuntimeError(f"{symbol} {interval} indisponible : {last}")


def build_export(pair_label, symbol, interval):
    df_full, source = fetch(symbol, interval)
    an = S.analyse(df_full, interval, source)
    n_full = len(df_full)
    off = max(0, n_full - VIEW)
    df = df_full.iloc[off:].reset_index(drop=True)
    m = len(df)

    def vis(idx):
        return int(idx - off) if idx >= off else None

    ema20 = S.ema(df["close"], 20).tolist()
    ema50 = S.ema(df["close"], 50).tolist()
    ml, ms, mh = S.macd(df_full["close"])
    ml = ml.iloc[off:].tolist(); ms = ms.iloc[off:].tolist(); mh = mh.iloc[off:].tolist()

    candles = [
        {"t": df["time"].iloc[i].strftime("%Y-%m-%d %H:%M"),
         "o": float(df["open"].iloc[i]), "h": float(df["high"].iloc[i]),
         "l": float(df["low"].iloc[i]), "c": float(df["close"].iloc[i]),
         "v": float(df["volume"].iloc[i])}
        for i in range(m)
    ]
    vlo = float(df["low"].min()); vhi = float(df["high"].max())
    price = an.price

    fresh = [f for f in an.fvgs if not f.filled and f.top >= vlo and f.bot <= vhi]
    fresh.sort(key=lambda f: abs((f.bot + f.top) / 2 - price))
    fvgs = [{"kind": f.kind, "x0": (vis(f.idx) if vis(f.idx) is not None else 0),
             "bot": round(f.bot, 4), "top": round(f.top, 4)} for f in fresh[:2]]

    want = "bullish" if an.bias == 1 else "bearish"
    cand = sorted([o for o in an.obs if o.kind == want],
                  key=lambda o: abs((o.low + o.high) / 2 - price))
    ob = None
    if cand:
        o = cand[0]
        ob = {"kind": o.kind, "x0": (vis(o.idx) if vis(o.idx) is not None else 0),
              "low": round(o.low, 4), "high": round(o.high, 4)}

    last_choch = next((e for e in reversed(an.events) if e.kind.startswith("CHoCH")), None)
    last_bos = next((e for e in reversed(an.events) if e.kind.startswith("BOS")), None)
    events = []
    for ev in [e for e in (last_choch, last_bos) if e is not None]:
        vx = vis(ev.idx)
        if vx is None:
            continue
        events.append({"kind": ev.kind, "label": "CHoCH" if ev.kind.startswith("CHoCH") else "BOS",
                       "vx": vx, "level": round(ev.level, 4), "up": ev.kind.endswith("up")})

    struct_seq = [{"kind": e.kind, "level": round(e.level, 4)} for e in an.events[-3:]]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        S.print_report(an)
    report_txt = buf.getvalue().replace("SOL/USDC", f"{pair_label}/USDC")

    ote_lo, ote_hi, ote_opt = an.ote
    return {
        "interval": interval, "source": source,
        "time_last": df["time"].iloc[-1].strftime("%Y-%m-%d %H:%M UTC"),
        "price": round(price, 4), "trend_txt": an.trend_txt, "bias": an.bias, "up_leg": an.up_leg,
        "swing_low": round(an.swing_low, 4), "swing_high": round(an.swing_high, 4),
        "macd_txt": an.macd_txt,
        "ote": {"lo": round(ote_lo, 4), "hi": round(ote_hi, 4), "opt": round(ote_opt, 4)},
        "bsl": round(an.bsl, 4) if an.bsl else None,
        "ssl": round(an.ssl, 4) if an.ssl else None,
        "vlo": round(vlo, 4), "vhi": round(vhi, 4),
        "candles": candles, "ema20": [round(x, 4) for x in ema20], "ema50": [round(x, 4) for x in ema50],
        "macd": {"line": [round(x, 5) for x in ml], "signal": [round(x, 5) for x in ms],
                 "hist": [round(x, 5) for x in mh]},
        "fvgs": fvgs, "ob": ob, "events": events, "struct_seq": struct_seq,
        "proposal": an.proposal, "notes": an.notes, "report_txt": report_txt,
    }


def build_payload():
    out = {"generated_utc": datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
           "pairs": [], "intervals": INTERVALS, "data": {}}
    for label, symbol in PAIRS.items():
        out["data"][label] = {}
        ok = False
        for iv in INTERVALS:
            try:
                out["data"][label][iv] = build_export(label, symbol, iv)
                ok = True
                print(f"OK  {label} {iv}  prix={out['data'][label][iv]['price']}", file=sys.stderr)
            except Exception as e:
                print(f"SKIP {label} {iv} : {e}", file=sys.stderr)
        if ok:
            out["pairs"].append(label)
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "terminal_build.html")
    payload = build_payload()
    if not payload["pairs"]:
        print("ERREUR : aucune donnee recuperee (reseau bloque ?).", file=sys.stderr)
        return 2
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    assert "</script>" not in data, "JSON contient une balise fermante interdite"
    with open(TEMPLATE, encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace("__PAYLOAD__", data)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"Ecrit {out_path}  paires={payload['pairs']}  scan={payload['generated_utc']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
