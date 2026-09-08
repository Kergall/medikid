# Analyse technique SOL/USDC (methodologie ICT / smart money)

Outil d'aide a la decision pour SOL/USDC. Il recupere les bougies OHLC et
applique une lecture « smart money » deterministe :

- **Structure de marche : BOS et CHoCH**, pour dater continuations et
  retournements.
- **OTE (Optimal Trade Entry)** : zone de retracement 0.62-0.79, point
  optimal a 0.705.
- **Fair Value Gaps / imbalances** : desequilibres laisses par une impulsion.
- **Zones de liquidite** : acheteuse au-dessus (BSL), vendeuse en dessous (SSL).
- **Order blocks** : derniere bougie opposee avant une forte impulsion.
- **MACD** et **EMA 20/50** : momentum et contexte de tendance.

Il propose eventuellement un ordre (entree, stop loss, take profit) avec un
ratio rendement/risque. Le graphique est rendu en portrait, fond sombre, gros
caracteres, pour une lecture facile sur telephone.

> Avertissement. Ceci est une aide heuristique et transparente, pas un signal
> garanti. La methodologie ICT (order blocks, FVG, OTE, BOS/CHoCH) est
> discretionnaire : les memes zones se tracent differemment selon l'analyste,
> et rien ne prouve qu'elle procure un avantage statistique reproductible.
> Empiler des indicateurs n'ajoute pas de certitude. Les niveaux proposes sont
> a valider par votre propre jugement. Ne risquez que ce que vous pouvez perdre.

## 1. Autoriser l'acces reseau (a faire une fois)

Par defaut, l'environnement Claude Code sur le web est en acces reseau
**Trusted**, qui bloque les API de cotation (Binance, Kraken, etc.). Il faut
passer l'environnement en **Custom** et y ajouter les domaines de donnees.

1. Sur [claude.ai/code](https://claude.ai/code), cliquer sur l'icone nuage
   affichant le nom de l'environnement (« Personnel »), au-dessus de la zone
   de message.
2. Survoler l'environnement et cliquer sur l'icone d'engrenage pour l'editer.
3. Dans **Network access**, choisir **Custom**.
4. Dans **Allowed domains**, coller un domaine par ligne :

   ```
   api.binance.com
   data-api.binance.vision
   api.kraken.com
   api.exchange.coinbase.com
   ```

5. Cocher **Also include default list of common package managers** (pour
   conserver l'acces a PyPI et pouvoir installer les bibliotheques).
6. Enregistrer.
7. **Demarrer une nouvelle session** sur ce depot et cette branche : la
   politique reseau est fixee au demarrage de la session, une session deja
   ouverte conserve son ancienne configuration.

## 2. Lancer une analyse

Depuis la racine du depot, dans une session dont l'acces reseau est autorise :

```bash
python3 -m pip install --quiet matplotlib pandas numpy   # une fois
python3 analysis/sol_usdc_analysis.py --interval 1h
```

Options :

| Option        | Role                                                        |
| ------------- | ----------------------------------------------------------- |
| `--interval`  | `5m`, `15m`, `1h`, `4h`, `1d` (defaut `1h`)                  |
| `--limit`     | nombre de bougies recuperees (defaut 300)                   |
| `--out`       | chemin du graphique PNG (defaut `sol_usdc_chart.png`)       |
| `--demo`      | donnees synthetiques, pour tester sans reseau               |

La commande affiche un rapport texte (prix, tendance, niveaux de Fibonacci,
order blocks, proposition d'ordre ou absence de setup) et enregistre le
graphique.

## 3. Sources de donnees

L'outil essaie les sources dans cet ordre et s'arrete a la premiere qui
repond : Binance (SOL/USDC), Binance Vision (SOL/USDC), Kraken (SOL/USD),
Coinbase (SOL/USDC). Selon la localisation reseau, certaines peuvent etre
indisponibles ; la redondance couvre ce cas. Aucune cle API n'est requise.

## 4. Comment lire le graphique et le raisonnement

- **Tendance / biais** : la structure de marche prime, l'EMA20/50 confirme.
  Si les deux divergent, l'outil le signale et invite a la prudence. On ne
  prend position que dans le sens du biais.
- **BOS (Break of Structure)** : cassure en cloture d'un sommet (ou creux) de
  reference dans le sens de la tendance -> continuation. Marque en vert
  (haussier) ou rouge (baissier).
- **CHoCH (Change of Character)** : premiere cassure en sens contraire ->
  signal precoce de retournement. C'est souvent le point de bascule du biais.
- **OTE (Optimal Trade Entry)** : zone ombree en jaune, retracement 0.62-0.79
  de la derniere impulsion. La ligne pointillee a 0.705 est le point d'entree
  optimal recherche par la methodologie ICT.
- **FVG / imbalance** : rectangles semi-transparents. Un desequilibre non
  comble agit comme un aimant ; le marche tend a y revenir avant de repartir.
  Les gaps negligeables (bruit de meche) sont filtres.
- **Zones de liquidite (BSL / SSL)** : lignes pointillees bleues. BSL
  au-dessus (stops des vendeurs, cible d'un long), SSL en dessous (stops des
  acheteurs, cible d'un short). Les objectifs sont fixes sur la liquidite
  opposee la plus proche.
- **Order blocks** : derniere bougie opposee avant une forte impulsion. On
  leur accorde du poids quand ils coincident avec l'OTE ou un FVG (confluence).
- **MACD** : confirmation du momentum (histogramme et croisement).
- **Proposition d'ordre** : generee uniquement en cas de confluence nette,
  a savoir prix dans l'OTE + un FVG et/ou un order block du meme sens
  chevauchant la zone + structure alignee, et si le ratio rendement/risque est
  au moins de 1,5. Le stop est place juste au-dela de la zone (invalidation
  propre), l'objectif sur la liquidite opposee. Sinon, l'outil indique
  explicitement qu'aucun ordre n'est justifie et qu'il vaut mieux attendre.

## 5. Limites assumees

- La detection des pivots, de la structure, des FVG et des order blocks est
  algorithmique et simplifiee ; elle ne remplace pas la lecture d'un operateur
  experimente et peut differer d'un trace manuel.
- L'outil analyse une seule unite de temps a la fois et ne tient pas compte du
  contexte macro ni des news. Croisez toujours avec une analyse en 4h/1j avant
  d'agir sur du 5m ou 1h.
- Aucun passage d'ordre n'est automatise : l'outil ne fait qu'analyser et
  proposer. L'execution reste entierement entre vos mains.
