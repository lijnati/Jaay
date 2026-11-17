# jaay : Vendez sans réseau.

> Traduction à relire par une personne francophone.

> **Démo SANDBOX : paiements simulés, aucun vrai bitcoin.** Taux de démo fixe (40 000 000 XOF par BTC). Le vrai Lightning n'a été essayé que sur regtest.

Jaay (« vendre » en wolof, orthographe à confirmer par une personne wolophone) est un point de vente open source. C'est une PWA sur le téléphone du commerçant, qui prend des paiements Lightning en mode avion. Conçu pour le Dakar Bitcoin Hack by BTrust. Version complète en anglais : [README.md](../README.md).

## Le problème

Pour vendre en Lightning, il faut en général une connexion de données sur le téléphone au moment de la vente, ou un appareil dédié. Un vendeur dont les données coupent ou s'épuisent en pleine vente perd la vente. [needs real evidence from Nahtty's interviews]

## Comment ça marche

1. Le commerçant tape un prix en XOF. Le téléphone affiche un QR LNURL-pay qui contient une charge utile chiffrée AES-256-GCM (montant, identifiant de vente aléatoire, devise).
2. Le client scanne avec n'importe quel portefeuille LNURL-pay. Le serveur déchiffre, convertit les XOF en sats au moment du scan (taux verrouillé 120 s) et crée la facture sur le portefeuille du commerçant, par une connexion en réception seule.
3. Après le paiement, le portefeuille affiche un lien de reçu. La page de reçu montre un code à 6 chiffres seulement une fois la facture réglée.
4. Le commerçant tape le code. Le téléphone le recalcule à partir de l'identifiant de vente avec un HMAC lié à l'appareil, 3 essais au maximum par vente. En ligne, le téléphone rapproche chaque vente avec le serveur et signale toute vente confirmée sans paiement.

## Démarrage rapide

Node 22.13 ou plus récent, pnpm 11 via corepack.

```bash
corepack enable
pnpm install
pnpm demo
```

- Application commerçant : http://localhost:8787/app/
- Simulateur de portefeuille client (SANDBOX) : http://localhost:8787/sim/
- Santé : http://localhost:8787/healthz

Tout est en SANDBOX : paiements simulés, aucun vrai bitcoin, taux de démo fixe. Détails : [QUICKSTART.md](QUICKSTART.md).

## Sécurité

- La charge utile du QR est chiffrée et refusée à la moindre modification.
- Une seule erreur uniforme pour tous les échecs LNURL.
- Le code de confirmation n'apparaît qu'après le règlement, n'est jamais dans la charge utile, et 3 essais par vente sont permis.
- Le rapprochement signale les ventes confirmées mais non payées.
- La connexion au portefeuille est refusée si elle peut dépenser.
- L'API de l'appareil est signée par HMAC, avec l'heure du serveur et une protection contre le rejeu.
- Secrets chiffrés au repos, aucun secret dans les journaux.
- CSP stricte, aucun script tiers, aucun CDN, clés non exportables sur le téléphone.

Modèle de menaces (en anglais) : [THREAT_MODEL.md](THREAT_MODEL.md).

## Limites

- Hors ligne, la confirmation repose sur le code. Le rapprochement détecte la fraude après coup.
- Un serveur compromis en cours d'exécution peut dériver les codes et voir les montants, mais ne peut pas dépenser depuis un portefeuille en réception seule.
- Un téléphone volé et déverrouillé peut créer des ventes. Pas encore de bouton de révocation, ni de code de verrouillage de l'application.
- La limitation de débit est par IP et en mémoire.
- NON TESTÉ : Safari, Firefox, vrais téléphones, Docker, hébergement. Mesures Lighthouse et réseau bridé : NON TESTÉES.
- Les vrais portefeuilles n'ont pas été testés avec le lien de reçu, seulement le simulateur.

Licence MIT.
