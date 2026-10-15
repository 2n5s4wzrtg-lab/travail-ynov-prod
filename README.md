# L'agence — plateforme de production & coordination

Plateforme web collaborative pour **L'agence**, la société de production d'Ynov Audiovisuel.
Elle sert à suivre les projets étudiants et clients, et surtout à **faire le relais entre le groupe de la semaine B et celui de la semaine C**.

## Ce que ça fait

| Fonction | Détail |
|---|---|
| **Profils** | Chacun crée son profil (nom, poste, semaine B ou C, couleur). Tout ce qui est ajouté est signé : *qui a fait quoi, quand*. **Un nouveau profil n'a aucun accès tant qu'un administrateur ne l'a pas accepté.** |
| **Projets** | Interne (étudiant) ou externe (client), type, statut (idée → pré-prod → tournage → post-prod → livré), responsable, date de livraison. |
| **Tâches** | Tableau kanban (à faire / en cours / bloqué / terminé), assignation, priorité, échéance, « à faire en semaine B ou C ». |
| **Journal & passation** | Notes datées et signées. Le type *Passation B ⇄ C* remonte sur le tableau de bord de l'autre groupe. |
| **Documents** | Dépôt de fichiers (scénario, budget, autorisations, rushs…) ou liens (Drive, WeTransfer…), classés par catégorie et signés. |
| **Planning** | Tournages, repérages, réunions, livraisons — vue globale par semaine avec alternance B/C. |
| **Équipe** | Annuaire par semaine, équipe par projet avec rôle. |
| **Admin** | **Acceptation ou refus des demandes d'adhésion**, retrait d'accès, rôles, réinitialisation de mot de passe, inversion du calendrier B/C, export JSON de sauvegarde. |

Le **premier profil créé devient administrateur** (créez-le vous-mêmes dès la mise en ligne, avant de partager le lien).

### Validation des inscriptions

- Quand quelqu'un crée un compte, sa demande est **« en attente »** : il ne peut ni se connecter, ni voir le moindre contenu.
- Les administrateurs voient un badge sur *Admin*, une bannière sur leur tableau de bord et la liste des demandes dans *Administration → Demandes d'adhésion* : **Accepter** ou **Refuser**.
- Un refus garde le compte bloqué (l'e-mail ne peut pas être réutilisé pour spammer) ; il peut être rétabli plus tard.
- On peut aussi **retirer l'accès** d'un membre déjà accepté : il est déconnecté immédiatement, ses contributions restent signées à son nom.
- Il n'y a pas d'envoi d'e-mail : l'administrateur consulte la liste, et la personne réessaie de se connecter plus tard.

## Base de données indépendante

Tout est stocké dans **un fichier SQLite** (`data/agence.db`) et un dossier `data/uploads/` pour les fichiers.
Aucun service externe, aucun compte tiers, aucune dépendance npm.

## Lancer

Prérequis : **Node.js 22.5 ou plus récent**.

```bash
npm start            # http://localhost:3000
npm test             # tests automatiques de l'API
```

Variables d'environnement (toutes facultatives) :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute | `3000` |
| `INVITE_CODE` | Code d'invitation exigé pour *envoyer* une demande (barrière supplémentaire, facultative : la validation par un admin reste obligatoire) | aucun |
| `DATA_DIR` | Dossier de la base et des fichiers | `./data` |
| `MAX_UPLOAD_MB` | Taille max d'un fichier | `200` |
| `TRUST_PROXY=1` | À activer derrière un reverse proxy HTTPS (cookie `Secure`, vraie IP) | désactivé |

## Mettre en ligne pour tout le monde

Il faut un hébergeur capable d'exécuter Node 22 **avec un disque persistant** (VPS, serveur de l'école, Render/Railway/Fly avec volume…).
⚠️ Sur un hébergement à disque éphémère, la base serait perdue à chaque redémarrage : montez un volume sur `DATA_DIR`.
Mettez-le derrière HTTPS (Caddy, Nginx, ou l'HTTPS de l'hébergeur) avec `TRUST_PROXY=1`. Un `INVITE_CODE` est un plus pour limiter le nombre de demandes parasites.

## Sauvegardes

- Copiez régulièrement le dossier `data/` (base + fichiers), serveur arrêté ou non (mode WAL).
- Ou, en admin : *Administration → Télécharger la sauvegarde* (export JSON des données, sans les fichiers).

## Semaines B / C

Les semaines alternent selon la parité du numéro de semaine ISO. Si la plateforme affiche l'inverse de votre emploi du temps :
*Administration → Inverser B et C*.

## Sécurité (résumé)

Inscription soumise à validation par un administrateur, mots de passe hachés (scrypt), sessions par cookie `HttpOnly`/`SameSite`, protection CSRF par en-tête, limitation des tentatives de connexion, contenu utilisateur toujours échappé, CSP stricte, fichiers servis en pièce jointe (sauf images/PDF/audio/vidéo) avec `nosniff` et `sandbox`, accès aux fichiers réservé aux connectés.

## Structure

```
server/   index.js (HTTP) · routes.js (API) · auth.js · db.js (SQLite)
public/   index.html · app.css · app.js · fonts/ (Outfit)
test/     api.test.js
```

Les autres fichiers du dépôt (planning de tournage, organisation journalière, classeur de production) sont des documents de travail indépendants de la plateforme.

## Vidéo de démonstration

`demo/demo-agence.mp4` montre un parcours complet (profil, validation d'une demande par l'admin, projet, tâches, documents, planning, passation B → C), avec sous-titres, voix off française et musique.

Pour la regénérer après une modification de l'interface (Playwright, ffmpeg, Python 3 + numpy requis) :

```bash
node demo/make-demo.js    # version sous-titrée, sans son
# avec voix off : installer piper-tts (pip) et un modèle français, puis
VOICE_PY=/chemin/venv/bin/python VOICE_MODEL=/chemin/fr_FR-siwis-medium.onnx node demo/make-demo.js
```

Les textes de la voix off sont dans `demo/make-demo.js` (objet `NARR`). La musique est générée par `demo/music.py` (composition originale, libre de droits).

**Crédits :** voix synthétisée avec [Piper](https://github.com/rhasspy/piper), modèle `fr_FR-siwis-medium` entraîné sur la base SIWIS (Université d'Édimbourg, licence CC-BY 4.0).
