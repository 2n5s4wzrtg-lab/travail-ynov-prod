'use strict';
/* Génère une vidéo de démonstration de la plateforme (sous-titrée, sans son).
   Usage :  node demo/make-demo.js            → demo/demo-agence.webm (+ .mp4 si ffmpeg est installé)
   Prérequis : playwright + chromium. Le script lance lui-même un serveur temporaire (données jetables). */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const OUT = __dirname;
const PORT = 3200 + Math.floor(Math.random() * 700);
let serverProc;

// Voix off (facultative) : Piper TTS + modèle français. Ex. :
//   VOICE_PY=/chemin/venv/bin/python VOICE_MODEL=/chemin/fr_FR-siwis-medium.onnx node demo/make-demo.js
const VOICE_PY = process.env.VOICE_PY;
const VOICE_MODEL = process.env.VOICE_MODEL;
const NARR = {
  n0: "Bienvenue sur L'agence, la plateforme de production et de coordination d'Ynov Audiovisuel. Voyons, avec un exemple concret, comment le groupe de la semaine B et celui de la semaine C se passent le relais sur un même projet.",
  n1: "D'abord, chacun crée son propre profil. C'est ce qui permet de savoir qui a fait quoi : tout ce qu'on ajoute ensuite est signé à son nom.",
  n2: "Camille indique qu'elle travaille en semaine B, puis elle valide.",
  n3: "Voici le tableau de bord : les projets en cours, les tâches, les notes laissées par l'autre semaine, et l'activité récente de toute l'équipe.",
  n4: "Camille crée un projet. Ici, un clip pour un client extérieur : le titre, le client, la date de livraison et le brief.",
  n5: "Chaque projet a son propre espace, avec des onglets pour les tâches, le journal, les documents, le planning, l'équipe et l'historique.",
  n6: "Elle ajoute les tâches. Pour chacune, elle précise la semaine à laquelle elle est destinée : B ou C.",
  n7: "Les tâches sont rangées en quatre colonnes : à faire, en cours, bloqué, terminé. Les pastilles B et C montrent à quel groupe revient chaque tâche.",
  n8: "Les documents du projet sont déposés au même endroit : scénario, budget, autorisations, rushs, ou simplement un lien Drive. Chaque fichier est signé et classé par catégorie.",
  n9a: "Elle planifie aussi le tournage dans le planning.",
  n9b: "La date tombe en semaine C : l'autre groupe saura qu'il doit être prêt.",
  n10: "Et voici le cœur du système : la note de passation. En fin de semaine, Camille résume où en est le projet : ce qui est fait, ce qui bloque, et ce qu'il reste à faire.",
  n11: "La note est automatiquement signée, avec son nom et sa semaine. Elle reste attachée au projet.",
  n12: "La semaine suivante, c'est au tour de Léo, du groupe C, de prendre le relais.",
  n13: "Il crée son profil, en semaine C.",
  n14: "Dès sa connexion, Léo voit sur son tableau de bord la passation laissée par la semaine B. Plus besoin de messages éparpillés : tout est au même endroit, avec l'auteur et la date.",
  n15: "Il s'attribue la tâche bloquée, et la passe en cours.",
  n16: "Il fait aussi avancer la réservation du matériel. Chaque carte indique qui l'a modifiée en dernier, et quand.",
  n17: "Puis il répond dans le journal pour tenir le groupe B informé. On obtient un vrai fil de discussion entre les deux semaines.",
  n18: "L'onglet activité garde l'historique complet : qui a fait quoi, et quand. C'est pratique pour le suivi du groupe et pour les bilans.",
  n19: "Le planning global regroupe tous les projets, semaine par semaine, avec l'alternance des semaines B et C.",
  n20: "L'équipe est rangée par semaine, avec le poste de chacun.",
  n21: "Voilà : un seul outil, deux semaines, une seule équipe. Chacun sait où en est le projet, même quand il n'était pas là la semaine d'avant.",
  n22: "L'agence. Un seul outil, deux semaines, une équipe.",
};
const VOICE_OFFSET = Number(process.env.VOICE_OFFSET || 0);
const clips = []; // { t (s depuis le début de la vidéo), file, dur }
let voiceEnd = 0;
let T0 = 0;
const now = () => (Date.now() - T0) / 1000;
function makeVoice(key, dir) {
  if (!VOICE_PY || !VOICE_MODEL || !NARR[key]) return null;
  const file = path.join(dir, key + '.wav');
  const r = spawnSync(VOICE_PY, ['-m', 'piper', '-m', VOICE_MODEL, '-f', file, '--length-scale', '1.05'], { input: NARR[key], encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Synthèse vocale impossible : ' + r.stderr);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  return { file, dur };
}
// Démarre la narration `key` (après la fin de la précédente) et renvoie sa durée.
async function say(key) {
  const v = voices[key];
  if (!v) return 0;
  const wait = voiceEnd + 0.5 - now();
  if (wait > 0) await sleep(wait * 1000);
  clips.push({ t: now(), file: v.file });
  voiceEnd = now() + v.dur;
  return v.dur;
}
const waitVoice = async () => { const w = voiceEnd + 0.4 - now(); if (w > 0) await sleep(w * 1000); };
let voices = {};
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;

const OVERLAY_CSS = `
#demo-cursor{position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.9);border:3px solid #ff2d7a;box-shadow:0 0 0 6px rgba(255,45,122,.25);pointer-events:none;left:640px;top:360px;transform:translate(-50%,-50%);transition:left .7s ease,top .7s ease,opacity .3s;opacity:0}
#demo-cursor.press{transform:translate(-50%,-50%) scale(.7)}
#demo-cap{pointer-events:none;position:fixed;z-index:99998;left:50%;bottom:26px;transform:translateX(-50%);max-width:1000px;width:max-content;background:rgba(0,0,0,.92);color:#fff;border:1px solid #3a3a45;border-radius:16px;padding:14px 24px;font:600 22px/1.35 Outfit,system-ui,sans-serif;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.6);transition:opacity .3s;opacity:0}
#demo-cap::before{content:'';position:absolute;left:16px;right:16px;top:0;height:3px;border-radius:2px;background:linear-gradient(90deg,#ff2d7a,#ff7a1a 25%,#ffd21a 50%,#2bd97c 72%,#1bb5ff)}
#demo-cap b.B{color:#1bb5ff}#demo-cap b.C{color:#ff2d7a}
#demo-card{position:fixed;inset:0;z-index:100000;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:Outfit,system-ui,sans-serif;text-align:center;padding:40px;transition:opacity .5s;opacity:0;pointer-events:none}
#demo-card h1{font-size:76px;font-weight:800;font-style:italic;letter-spacing:-.03em;margin:0}
#demo-card .bar{width:300px;height:8px;border-radius:4px;background:linear-gradient(90deg,#ff2d7a,#ff7a1a 25%,#ffd21a 50%,#2bd97c 72%,#1bb5ff)}
#demo-card p{font-size:28px;color:#c9c9d3;max-width:900px;margin:0;line-height:1.4}
`;

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agence-demo-'));
  const server = serverProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: data, HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch { /* attente */ } await sleep(100); }

  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agence-video-'));
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'agence-voice-'));
  if (VOICE_PY && VOICE_MODEL) for (const k of Object.keys(NARR)) voices[k] = makeVoice(k, adir);
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } }, bypassCSP: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  T0 = Date.now();

  const inject = () => page.evaluate((css) => {
    if (document.getElementById('demo-cap')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    for (const [tag, id] of [['div', 'demo-cursor'], ['div', 'demo-cap'], ['div', 'demo-card']]) { const e = document.createElement(tag); e.id = id; document.body.append(e); }
  }, OVERLAY_CSS);

  // --- sous-titres & cartons ---
  const cap = async (html, ms = 3500, key) => {
    if (key) await say(key);
    await page.evaluate((h) => { const c = document.getElementById('demo-cap'); c.innerHTML = h; c.style.opacity = h ? 1 : 0; }, html);
    await sleep(ms);
  };
  const hideCap = () => page.evaluate(() => { document.getElementById('demo-cap').style.opacity = 0; });
  const card = async (title, sub, ms = 3500, key) => {
    if (key) { const d = await say(key); ms = Math.max(ms, d * 1000 + 600); }
    await page.evaluate(([t, s]) => { const c = document.getElementById('demo-card'); c.replaceChildren(); const h = document.createElement('h1'); h.textContent = t; const b = document.createElement('div'); b.className = 'bar'; const p = document.createElement('p'); p.textContent = s; c.append(h, b, p); c.style.opacity = 1; }, [title, sub]);
    await sleep(ms);
    await page.evaluate(() => { document.getElementById('demo-card').style.opacity = 0; });
    await sleep(500);
  };

  // --- curseur & actions visibles ---
  const moveTo = async (loc) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.evaluate(([x, y]) => { const c = document.getElementById('demo-cursor'); c.style.opacity = 1; c.style.left = x + 'px'; c.style.top = y + 'px'; }, [b.x + b.width / 2, b.y + b.height / 2]);
    await sleep(800);
  };
  const click = async (sel, opts = {}) => {
    const loc = page.locator(sel).first();
    await moveTo(loc);
    await page.evaluate(() => document.getElementById('demo-cursor').classList.add('press'));
    await sleep(120);
    await loc.click(opts);
    await page.evaluate(() => document.getElementById('demo-cursor').classList.remove('press'));
    await sleep(450);
  };
  const type = async (sel, text, delay = 38) => {
    const loc = page.locator(sel).first();
    await moveTo(loc);
    await loc.click();
    await loc.pressSequentially(text, { delay });
    await sleep(250);
  };
  const choose = async (sel, value) => { const loc = page.locator(sel).first(); await moveTo(loc); await loc.selectOption(value); await sleep(500); };
  const setDate = async (sel, value) => { const loc = page.locator(sel).first(); await moveTo(loc); await loc.fill(value); await sleep(450); };

  const B = (t) => `<b class="B">${t}</b>`;
  const C = (t) => `<b class="C">${t}</b>`;

  // ============ SCÉNARIO ============
  await page.goto(BASE + '/');
  await page.waitForSelector('.auth-box');
  await inject();
  await card("L'agence", 'La plateforme de production d\'Ynov Audiovisuel — démonstration', 3800, 'n0');

  // 1. Inscription Camille (semaine B)
  await cap('1 · Chacun crée <b>son profil</b> : ses ajouts seront toujours signés à son nom.', 3800, 'n1');
  await type('input[name=name]', 'Camille Dupont');
  await type('input[name=job]', 'Réalisatrice');
  await type('input[name=email]', 'camille@ynov.com');
  await type('input[name=password]', 'motdepasse1', 30);
  await cap(`Camille choisit sa semaine de travail : ${B('semaine B')}.`, 2500, 'n2');
  await click('.seg label >> text=Semaine B');
  await click('button:has-text("Créer mon profil")');
  await page.waitForSelector('.week-banner');
  await cap('Le tableau de bord : projets en cours, tâches, passations de l\'autre semaine et activité récente.', 4500, 'n3');

  // 2. Projet
  await cap('2 · Elle crée un <b>projet</b> — ici un clip pour un client extérieur.', 3000, 'n4');
  await click('.nav >> text=Projets');
  await click('text=+ Nouveau projet');
  await type('input[name=title]', 'Clip « Néon »');
  await choose('select[name=origin]', 'externe');
  await type('input[name=client]', 'Studio Lune');
  await setDate('input[name=deadline]', '2026-12-05');
  await type('textarea[name=description]', 'Clip de 3 minutes, tournage de nuit en centre-ville.', 25);
  await click('button:has-text("Créer le projet")');
  await page.waitForSelector('.kanban');
  await cap('Le projet a son espace : tâches, journal, documents, planning, équipe, activité.', 4000, 'n5');

  // 3. Tâches
  await cap('3 · Elle répartit les <b>tâches</b> et précise pour quelle semaine elles sont prévues.', 3500, 'n6');
  const tasks = [
    ['Repérage des lieux', 'doing', 'B', '2026-10-16'],
    ['Obtenir l\'autorisation de tournage', 'blocked', 'C', '2026-10-19'],
    ['Réserver le matériel caméra', 'todo', 'C', '2026-10-19'],
  ];
  for (const [title, status, week, due] of tasks) {
    await click('text=+ Nouvelle tâche');
    await type('input[name=title]', title, 28);
    await choose('select[name=status]', status);
    await choose('select[name=week_group]', week);
    await setDate('input[name=due_date]', due);
    await click('.modal button:has-text("Ajouter")');
    await page.waitForSelector(`.tcard:has-text("${title}")`);
  }
  await cap(`Colonnes <b>À faire / En cours / Bloqué / Terminé</b> — les badges ${B('B')} et ${C('C')} montrent à qui revient la tâche.`, 5000, 'n7');

  // 4. Document
  await cap('4 · Les <b>documents</b> du projet sont déposés au même endroit, signés et classés.', 3500, 'n8');
  await click('.tabs >> text=Documents');
  await choose('select[aria-label="Catégorie"]', 'scenario');
  fs.writeFileSync(path.join(data, 'Scenario_Neon_v1.pdf'), '%PDF-1.4 demo');
  await moveTo(page.locator('.drop'));
  await page.locator('input[type=file]').setInputFiles(path.join(data, 'Scenario_Neon_v1.pdf'));
  await page.waitForSelector('.doc');
  await cap('Scénario, budget, autorisations, rushs… ou simplement un lien Drive / WeTransfer.', 4000);

  // 5. Planning
  await cap('5 · Elle planifie le <b>tournage</b> dans le planning.', 3000, 'n9a');
  await click('.tabs >> text=Planning');
  await click('text=+ Planifier');
  await type('input[name=title]', 'Tournage de nuit — jour 1', 28);
  await setDate('input[name=date]', '2026-10-20');
  await setDate('input[name=start_time]', '20:00');
  await setDate('input[name=end_time]', '23:30');
  await type('input[name=location]', 'Place de la République', 28);
  await click('.modal button:has-text("Planifier")');
  await page.waitForSelector('.ev');
  await cap(`Le tournage tombe en ${C('semaine C')} : l'autre groupe devra être prêt.`, 4000, 'n9b');

  // 6. Passation
  await cap('6 · Fin de semaine : la clé du système, la <b>note de passation</b>.', 3500, 'n10');
  await click('.tabs >> text=Journal');
  await type('textarea[aria-label="Nouveau message"]', 'Repérage fait : lieu validé. Il manque l\'autorisation de la mairie (dossier déposé lundi). Matériel à réserver avant mardi !', 22);
  await cap('Type « Passation B ⇄ C », signé automatiquement : Camille · semaine B.', 3500);
  await click('button:has-text("Publier")');
  await page.waitForSelector('.note');
  await cap('La note reste attachée au projet et sera mise en avant pour l\'autre groupe.', 3500, 'n11');

  // 7. Déconnexion → Léo (semaine C)
  await hideCap();
  await click('button:has-text("Déconnexion")');
  await page.waitForSelector('.auth-box');
  await card('Semaine suivante…', 'Léo, du groupe C, prend le relais', 3200, 'n12');
  await cap(`Léo crée son profil en ${C('semaine C')}.`, 2500, 'n13');
  await click('text=Créer mon profil');
  await page.waitForSelector('input[name=name]');
  await type('input[name=name]', 'Léo Martin');
  await type('input[name=job]', 'Cadreur', 30);
  await type('input[name=email]', 'leo@ynov.com');
  await type('input[name=password]', 'motdepasse2', 30);
  await click('.seg label >> text=Semaine C');
  await click('button:has-text("Créer mon profil")');
  await page.waitForSelector('.week-banner');
  await sleep(500);

  await cap(`7 · Dès sa connexion, Léo voit la <b>passation</b> laissée par la ${B('semaine B')} sur son tableau de bord.`, 4500, 'n14');
  await page.locator('.note.passation').first().scrollIntoViewIfNeeded();
  await sleep(1500);
  await cap('Plus besoin de messages éparpillés : tout est au même endroit, avec l\'auteur et la date.', 3800);
  await click('.note.passation a');
  await page.waitForSelector('.kanban', { timeout: 5000 }).catch(() => {});
  await click('.tabs >> text=Tâches');
  await page.waitForSelector('.kanban');

  // 8. Léo prend une tâche
  await cap('8 · Léo s\'attribue la tâche bloquée et la passe <b>En cours</b>.', 3500, 'n15');
  await click('.tcard:has-text("autorisation de tournage")');
  await choose('select[name=assignee_id]', { label: 'Léo Martin (C)' });
  await choose('select[name=status]', 'doing');
  await click('.modal button:has-text("Enregistrer")');
  await sleep(600);
  await cap('Il fait aussi avancer la réservation du matériel avec la flèche →.', 3000, 'n16');
  await click('.tcard:has-text("matériel caméra") .adv');
  await sleep(500);
  await cap('Chaque carte indique qui l\'a modifiée en dernier, et quand.', 4000);

  // 9. Journal : réponse
  await cap('9 · Il répond dans le <b>journal</b> pour tenir le groupe B informé.', 3200, 'n17');
  await click('.tabs >> text=Journal');
  await choose('select[aria-label="Type de note"]', 'passation');
  await type('textarea[aria-label="Nouveau message"]', 'Mairie contactée : réponse attendue jeudi. Caméra réservée. Besoin d\'un 2e micro cravate.', 22);
  await click('button:has-text("Publier")');
  await page.waitForSelector('.note:nth-child(2)');
  await cap(`Deux notes, deux auteurs, deux semaines : ${B('B')} → ${C('C')} → ${B('B')} …`, 4000);

  // 10. Activité
  await cap('10 · L\'onglet <b>Activité</b> garde l\'historique : qui a fait quoi, et quand.', 3500, 'n18');
  await click('.tabs >> text=Activité');
  await page.waitForSelector('.item');
  await cap('Utile pour le suivi de l\'équipe, les bilans et l\'évaluation du travail de chacun.', 4500);

  // 11. Planning global
  await cap('11 · Le <b>planning global</b> regroupe tous les projets, semaine par semaine.', 3200, 'n19');
  await click('.nav >> text=Planning');
  await page.waitForSelector('.week-block');
  await cap(`Les semaines ${B('B')} et ${C('C')} alternent : on voit d'un coup d'œil qui est de service.`, 4500);

  // 12. Équipe
  await click('.nav >> text=Équipe');
  await page.waitForSelector('.person');
  await cap('12 · L\'équipe est rangée par semaine, avec le poste de chacun.', 4000, 'n20');

  // 13. Dashboard final
  await click('.nav >> text=Tableau de bord');
  await page.waitForSelector('.stats');
  await cap('13 · Retour au tableau de bord : tes tâches, les prochaines dates et l\'activité du groupe.', 4500, 'n21');
  await waitVoice();
  await hideCap();
  await card("L'agence", 'Un seul outil · deux semaines · une équipe', 4200, 'n22');

  const videoPath = await page.video().path();
  await ctx.close();
  await browser.close();
  server.kill();

  const webm = path.join(OUT, 'demo-agence.webm');
  fs.copyFileSync(videoPath, webm);
  const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  const mp4 = path.join(OUT, 'demo-agence.mp4');
  const venc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium', '-movflags', '+faststart'];
  try {
    if (clips.length) {
      // Musique générée + voix off calée sur les sous-titres, la musique baisse quand la voix parle.
      const total = probe(webm);
      const music = path.join(adir, 'musique.wav');
      execFileSync('python3', [path.join(__dirname, 'music.py'), String(Math.ceil(total) + 1), music], { stdio: 'inherit' });
      const args = ['-y', '-loglevel', 'error', '-i', webm, '-i', music];
      clips.forEach((c) => args.push('-i', c.file));
      const delays = clips.map((c, i) => { const ms = Math.round((c.t + VOICE_OFFSET) * 1000); return `[${i + 2}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`; });
      const fc = [...delays,
        `${clips.map((_, i) => `[v${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,volume=1.8,asplit=2[vo1][vo2]`,
        '[1:a]volume=0.55[m]',
        '[m][vo1]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=500[duck]',
        '[duck][vo2]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.93[a]'].join(';');
      args.push('-filter_complex', fc, '-map', '0:v', '-map', '[a]', ...venc, '-c:a', 'aac', '-b:a', '192k', '-t', String(total), mp4);
      execFileSync('ffmpeg', args);
      console.log('MP4 avec musique et voix off prêt : demo/demo-agence.mp4');
    } else {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, ...venc, mp4]);
      console.log('MP4 (sans son) prêt : demo/demo-agence.mp4');
    }
  } catch (e) { console.log('Échec ffmpeg :', e.message.slice(0, 400)); }
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(vdir, { recursive: true, force: true });
})().catch((e) => { console.error('ÉCHEC', e); serverProc?.kill(); process.exit(1); });
