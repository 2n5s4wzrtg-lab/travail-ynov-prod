# L'agence — plateforme de production & coordination

Plateforme web collaborative pour **L'agence**, la société de production d'Ynov Audiovisuel.
Elle sert à suivre les projets étudiants et clients, et surtout à **faire le relais entre le groupe de la semaine B et celui de la semaine C**.

## Ce que ça fait

| Fonction | Détail |
|---|---|
| **Profils** | Chacun crée son profil (nom, poste, semaine B ou C, couleur). Tout ce qui est ajouté est signé : *qui a fait quoi, quand*. |
| **Projets** | Interne (étudiant) ou externe (client), type, statut (idée → pré-prod → tournage → post-prod → livré), responsable, date de livraison. |
| **Tâches** | Tableau kanban (à faire / en cours / bloqué / terminé), assignation, priorité, échéance, « à faire en semaine B ou C ». |
| **Journal & passation** | Notes datées et signées. Le type *Passation B ⇄ C* remonte sur le tableau de bord de l'autre groupe. |
| **Documents** | Dépôt de fichiers (scénario, budget, autorisations, rushs…) ou liens (Drive, WeTransfer…), classés par catégorie et signés. |
| **Planning** | Tournages, repérages, réunions, livraisons — vue globale par semaine avec alternance B/C. |
| **Équipe** | Annuaire par semaine, équipe par projet avec rôle. |
| **Admin** | Rôles, réinitialisation de mot de passe, inversion du calendrier B/C, export JSON de sauvegarde. |

Le **premier profil créé devient administrateur**.

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
| `INVITE_CODE` | Code d'invitation exigé à l'inscription (**recommandé dès que le site est en ligne**) | aucun |
| `DATA_DIR` | Dossier de la base et des fichiers | `./data` |
| `MAX_UPLOAD_MB` | Taille max d'un fichier | `200` |
| `TRUST_PROXY=1` | À activer derrière un reverse proxy HTTPS (cookie `Secure`, vraie IP) | désactivé |

## Mettre en ligne pour tout le monde

Il faut un hébergeur capable d'exécuter Node 22 **avec un disque persistant** (VPS, serveur de l'école, Render/Railway/Fly avec volume…).
⚠️ Sur un hébergement à disque éphémère, la base serait perdue à chaque redémarrage : montez un volume sur `DATA_DIR`.
Mettez-le derrière HTTPS (Caddy, Nginx, ou l'HTTPS de l'hébergeur) avec `TRUST_PROXY=1` et un `INVITE_CODE`.

## Sauvegardes

- Copiez régulièrement le dossier `data/` (base + fichiers), serveur arrêté ou non (mode WAL).
- Ou, en admin : *Administration → Télécharger la sauvegarde* (export JSON des données, sans les fichiers).

## Semaines B / C

Les semaines alternent selon la parité du numéro de semaine ISO. Si la plateforme affiche l'inverse de votre emploi du temps :
*Administration → Inverser B et C*.

## Sécurité (résumé)

Mots de passe hachés (scrypt), sessions par cookie `HttpOnly`/`SameSite`, protection CSRF par en-tête, limitation des tentatives de connexion, contenu utilisateur toujours échappé, CSP stricte, fichiers servis en pièce jointe (sauf images/PDF/audio/vidéo) avec `nosniff` et `sandbox`, accès aux fichiers réservé aux connectés.

## Structure

```
server/   index.js (HTTP) · routes.js (API) · auth.js · db.js (SQLite)
public/   index.html · app.css · app.js · fonts/ (Outfit)
test/     api.test.js
```

Les autres fichiers du dépôt (planning de tournage, organisation journalière, classeur de production) sont des documents de travail indépendants de la plateforme.

## Vidéo de démonstration

`demo/demo-agence.mp4` montre un parcours complet (profil, projet, tâches, documents, planning, passation B → C).
Pour la regénérer après une modification de l'interface : `node demo/make-demo.js` (nécessite Playwright et ffmpeg).
