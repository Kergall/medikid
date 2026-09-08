# Analyse technique SOL/USDC

Outil d'aide a la decision pour SOL/USDC : il recupere les bougies OHLC,
en deduit la structure de marche, trace un retracement de Fibonacci, repere
les order blocks, et propose eventuellement un ordre (entree, stop loss,
take profit) avec un ratio rendement/risque. Le graphique est rendu en
orientation portrait, fond sombre, gros caracteres, pour une lecture facile
sur telephone.

> Avertissement. Ceci est une aide heuristique et transparente, pas un signal
> garanti. La methode « order blocks / Fibonacci » est discretionnaire : les
> memes zones se tracent differemment selon l'analyste, et rien ne prouve
> qu'elle procure un avantage statistique reproductible. Les niveaux proposes
> sont a valider par votre propre jugement. Ne risquez que ce que vous pouvez
> perdre.

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

- **Tendance** : deduite de deux moyennes mobiles exponentielles. EMA20 au
  dessus de l'EMA50, prix au-dessus de l'EMA20 -> tendance haussiere ; la
  configuration inverse -> baissiere ; sinon indecise. On ne prend une
  position que dans le sens de la tendance.
- **Fibonacci** : trace sur la derniere impulsion (du dernier creux au dernier
  sommet, ou l'inverse). Le « golden pocket » (0.618-0.705), zone ombree en
  jaune, est la zone de retracement ou les impulsions reprennent le plus
  souvent.
- **Order blocks** : la derniere bougie de couleur opposee avant une forte
  impulsion. Un OB haussier (zone verte) marque une zone de demande ; un OB
  baissier (zone rouge) une zone d'offre. On leur accorde du poids quand ils
  coincident avec un niveau de Fibonacci (confluence).
- **Proposition d'ordre** : generee uniquement si le prix se trouve sur une
  zone de confluence nette (golden pocket et/ou order block), dans le sens de
  la tendance, et si le ratio rendement/risque est au moins de 1,5. Le stop
  est place juste au-dela de la zone (invalidation propre), l'objectif sur
  l'extremite de l'impulsion. Sinon, l'outil indique explicitement qu'aucun
  ordre n'est justifie et qu'il vaut mieux attendre.

## 5. Limites assumees

- La detection des swings et des order blocks est algorithmique et simplifiee ;
  elle ne remplace pas la lecture d'un graphique par un operateur experimente.
- L'outil ne tient pas compte du contexte macro, des news, ni des unites de
  temps superieures. Croisez toujours avec une analyse en 4h/1j avant d'agir
  sur du 5m ou 1h.
- Aucun passage d'ordre n'est automatise : l'outil ne fait qu'analyser et
  proposer. L'execution reste entierement entre vos mains.
