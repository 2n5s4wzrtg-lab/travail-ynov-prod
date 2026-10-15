'use strict';
/* Génère une vidéo de démonstration de la plateforme (sous-titrée, sans son).
   Usage :  node demo/make-demo.js            → demo/demo-agence.webm (+ .mp4 si ffmpeg est installé)
   Prérequis : playwright + chromium. Le script lance lui-même un serveur temporaire (données jetables). */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const OUT = __dirname;
const PORT = 3200 + Math.floor(Math.random() * 700);
let serverProc;
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
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } }, bypassCSP: true, locale: 'fr-FR' });
  const page = await ctx.newPage();

  const inject = () => page.evaluate((css) => {
    if (document.getElementById('demo-cap')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    for (const [tag, id] of [['div', 'demo-cursor'], ['div', 'demo-cap'], ['div', 'demo-card']]) { const e = document.createElement(tag); e.id = id; document.body.append(e); }
  }, OVERLAY_CSS);

  // --- sous-titres & cartons ---
  const cap = async (html, ms = 3500) => {
    await page.evaluate((h) => { const c = document.getElementById('demo-cap'); c.innerHTML = h; c.style.opacity = h ? 1 : 0; }, html);
    await sleep(ms);
  };
  const hideCap = () => page.evaluate(() => { document.getElementById('demo-cap').style.opacity = 0; });
  const card = async (title, sub, ms = 3500) => {
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
  await card("L'agence", 'La plateforme de production d\'Ynov Audiovisuel — démonstration', 3800);

  // 1. Inscription Camille (semaine B)
  await cap('1 · Chacun crée <b>son profil</b> : ses ajouts seront toujours signés à son nom.', 3800);
  await type('input[name=name]', 'Camille Dupont');
  await type('input[name=job]', 'Réalisatrice');
  await type('input[name=email]', 'camille@ynov.com');
  await type('input[name=password]', 'motdepasse1', 30);
  await cap(`Camille choisit sa semaine de travail : ${B('semaine B')}.`, 2500);
  await click('.seg label >> text=Semaine B');
  await click('button:has-text("Créer mon profil")');
  await page.waitForSelector('.week-banner');
  await cap('Le tableau de bord : projets en cours, tâches, passations de l\'autre semaine et activité récente.', 4500);

  // 2. Projet
  await cap('2 · Elle crée un <b>projet</b> — ici un clip pour un client extérieur.', 3000);
  await click('.nav >> text=Projets');
  await click('text=+ Nouveau projet');
  await type('input[name=title]', 'Clip « Néon »');
  await choose('select[name=origin]', 'externe');
  await type('input[name=client]', 'Studio Lune');
  await setDate('input[name=deadline]', '2026-12-05');
  await type('textarea[name=description]', 'Clip de 3 minutes, tournage de nuit en centre-ville.', 25);
  await click('button:has-text("Créer le projet")');
  await page.waitForSelector('.kanban');
  await cap('Le projet a son espace : tâches, journal, documents, planning, équipe, activité.', 4000);

  // 3. Tâches
  await cap('3 · Elle répartit les <b>tâches</b> et précise pour quelle semaine elles sont prévues.', 3500);
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
  await cap(`Colonnes <b>À faire / En cours / Bloqué / Terminé</b> — les badges ${B('B')} et ${C('C')} montrent à qui revient la tâche.`, 5000);

  // 4. Document
  await cap('4 · Les <b>documents</b> du projet sont déposés au même endroit, signés et classés.', 3500);
  await click('.tabs >> text=Documents');
  await choose('select[aria-label="Catégorie"]', 'scenario');
  fs.writeFileSync(path.join(data, 'Scenario_Neon_v1.pdf'), '%PDF-1.4 demo');
  await moveTo(page.locator('.drop'));
  await page.locator('input[type=file]').setInputFiles(path.join(data, 'Scenario_Neon_v1.pdf'));
  await page.waitForSelector('.doc');
  await cap('Scénario, budget, autorisations, rushs… ou simplement un lien Drive / WeTransfer.', 4000);

  // 5. Planning
  await cap('5 · Elle planifie le <b>tournage</b> dans le planning.', 3000);
  await click('.tabs >> text=Planning');
  await click('text=+ Planifier');
  await type('input[name=title]', 'Tournage de nuit — jour 1', 28);
  await setDate('input[name=date]', '2026-10-20');
  await setDate('input[name=start_time]', '20:00');
  await setDate('input[name=end_time]', '23:30');
  await type('input[name=location]', 'Place de la République', 28);
  await click('.modal button:has-text("Planifier")');
  await page.waitForSelector('.ev');
  await cap(`Le tournage tombe en ${C('semaine C')} : l'autre groupe devra être prêt.`, 4000);

  // 6. Passation
  await cap('6 · Fin de semaine : la clé du système, la <b>note de passation</b>.', 3500);
  await click('.tabs >> text=Journal');
  await type('textarea[aria-label="Nouveau message"]', 'Repérage fait : lieu validé. Il manque l\'autorisation de la mairie (dossier déposé lundi). Matériel à réserver avant mardi !', 22);
  await cap('Type « Passation B ⇄ C », signé automatiquement : Camille · semaine B.', 3500);
  await click('button:has-text("Publier")');
  await page.waitForSelector('.note');
  await cap('La note reste attachée au projet et sera mise en avant pour l\'autre groupe.', 3500);

  // 7. Déconnexion → Léo (semaine C)
  await hideCap();
  await click('button:has-text("Déconnexion")');
  await page.waitForSelector('.auth-box');
  await card('Semaine suivante…', 'Léo, du groupe C, prend le relais', 3200);
  await cap(`Léo crée son profil en ${C('semaine C')}.`, 2500);
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

  await cap(`7 · Dès sa connexion, Léo voit la <b>passation</b> laissée par la ${B('semaine B')} sur son tableau de bord.`, 4500);
  await page.locator('.note.passation').first().scrollIntoViewIfNeeded();
  await sleep(1500);
  await cap('Plus besoin de messages éparpillés : tout est au même endroit, avec l\'auteur et la date.', 3800);
  await click('.note.passation a');
  await page.waitForSelector('.kanban', { timeout: 5000 }).catch(() => {});
  await click('.tabs >> text=Tâches');
  await page.waitForSelector('.kanban');

  // 8. Léo prend une tâche
  await cap('8 · Léo s\'attribue la tâche bloquée et la passe <b>En cours</b>.', 3500);
  await click('.tcard:has-text("autorisation de tournage")');
  await choose('select[name=assignee_id]', { label: 'Léo Martin (C)' });
  await choose('select[name=status]', 'doing');
  await click('.modal button:has-text("Enregistrer")');
  await sleep(600);
  await cap('Il fait aussi avancer la réservation du matériel avec la flèche →.', 3000);
  await click('.tcard:has-text("matériel caméra") .adv');
  await sleep(500);
  await cap('Chaque carte indique qui l\'a modifiée en dernier, et quand.', 4000);

  // 9. Journal : réponse
  await cap('9 · Il répond dans le <b>journal</b> pour tenir le groupe B informé.', 3200);
  await click('.tabs >> text=Journal');
  await choose('select[aria-label="Type de note"]', 'passation');
  await type('textarea[aria-label="Nouveau message"]', 'Mairie contactée : réponse attendue jeudi. Caméra réservée. Besoin d\'un 2e micro cravate.', 22);
  await click('button:has-text("Publier")');
  await page.waitForSelector('.note:nth-child(2)');
  await cap(`Deux notes, deux auteurs, deux semaines : ${B('B')} → ${C('C')} → ${B('B')} …`, 4000);

  // 10. Activité
  await cap('10 · L\'onglet <b>Activité</b> garde l\'historique : qui a fait quoi, et quand.', 3500);
  await click('.tabs >> text=Activité');
  await page.waitForSelector('.item');
  await cap('Utile pour le suivi de l\'équipe, les bilans et l\'évaluation du travail de chacun.', 4500);

  // 11. Planning global
  await cap('11 · Le <b>planning global</b> regroupe tous les projets, semaine par semaine.', 3200);
  await click('.nav >> text=Planning');
  await page.waitForSelector('.week-block');
  await cap(`Les semaines ${B('B')} et ${C('C')} alternent : on voit d'un coup d'œil qui est de service.`, 4500);

  // 12. Équipe
  await click('.nav >> text=Équipe');
  await page.waitForSelector('.person');
  await cap('12 · L\'équipe est rangée par semaine, avec le poste de chacun.', 4000);

  // 13. Dashboard final
  await click('.nav >> text=Tableau de bord');
  await page.waitForSelector('.stats');
  await cap('13 · Retour au tableau de bord : tes tâches, les prochaines dates et l\'activité du groupe.', 4500);
  await hideCap();
  await card("L'agence", 'Un seul outil · deux semaines · une équipe', 4200);

  const videoPath = await page.video().path();
  await ctx.close();
  await browser.close();
  server.kill();

  const webm = path.join(OUT, 'demo-agence.webm');
  fs.copyFileSync(videoPath, webm);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium', '-movflags', '+faststart', path.join(OUT, 'demo-agence.mp4')]);
    console.log('MP4 prêt : demo/demo-agence.mp4');
  } catch { console.log('ffmpeg indisponible : seule la version .webm a été créée.'); }
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(vdir, { recursive: true, force: true });
})().catch((e) => { console.error('ÉCHEC', e); serverProc?.kill(); process.exit(1); });
