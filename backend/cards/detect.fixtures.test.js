// Real agent answers (Antigravity, French and English) → the card each one should open.
// fixtures/agent-answers.json: { expected, question, answer } collected from the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectSpecialContent } from './detect.generated.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-answers.json', import.meta.url), 'utf8'));
const answer = (q) => fixtures.find((f) => f.question.startsWith(q)).answer;
const detect = (q) => detectSpecialContent(answer(q));

test('every real answer opens its card', () => {
  const misses = fixtures.filter((f) => detectSpecialContent(f.answer)?.type !== f.expected).map((f) => `${f.expected}: ${f.question}`);
  assert.deepEqual(misses, []);
});

test('flight: codes in parentheses, French and English, status and times', () => {
  const af = detect('Quel est le statut du vol AF1234').data;
  assert.equal(af.flightNumber, 'AF1234');
  assert.equal(af.airline, 'Air France');
  assert.equal(af.origin.code, 'CDG');
  assert.equal(af.destination.code, 'BER');
  assert.equal(af.status, 'LANDED');
  assert.equal(af.origin.scheduledTime, '12:30');
  assert.equal(af.destination.estimatedTime, '14:15');
  assert.equal(af.origin.terminal, '2F');
  const ba = detect('What is the status of flight BA117').data;
  assert.deepEqual([ba.flightNumber, ba.airline, ba.origin.code, ba.destination.code, ba.status], ['BA117', 'British Airways', 'LHR', 'JFK', 'LANDED']);
  assert.equal(ba.origin.terminal, '5');
  assert.equal(ba.destination.terminal, '8');
});

test('sports: "s’est imposé 2-1 face à…", "fell 2–1 to…"', () => {
  const psg = detect('Quel est le score du dernier match du PSG').data;
  assert.deepEqual([psg.teamA.name, psg.teamA.score, psg.teamB.name, psg.teamB.score], ['Paris Saint-Germain', 2, 'Olympique de Marseille', 1]);
  assert.equal(psg.league, 'Ligue 1');
  const rm = detect('What was the score of the last Real Madrid').data;
  assert.deepEqual([rm.teamA.name, rm.teamA.score, rm.teamB.name, rm.teamB.score], ['Real Madrid', 1, 'Atlético Madrid', 2]);
});

test('recipe: bold and French headings', () => {
  const crepes = detect('Donne-moi une recette de crêpes').data;
  assert.ok(crepes.ingredients.length >= 5);
  assert.ok(crepes.ingredients.some((i) => i.item === '250 g de farine'), 'bold markers removed');
  assert.ok(crepes.steps.length >= 3);
  const guac = detect('Give me a recipe for guacamole').data;
  assert.ok(guac.ingredients.length >= 6);
  assert.ok(guac.steps.length >= 3);
  assert.match(guac.title, /guacamole/i);
});

test('translation: "se traduit par", "is translated as" + romanization and alternatives', () => {
  const fr = detect("Traduis 'bonjour, comment ça va").data;
  assert.equal(fr.translatedText, 'Hello, how are you?');
  assert.match(fr.targetLang, /anglais/i);
  const ja = detect("Translate 'thank you very much'").data;
  assert.equal(ja.translatedText, 'どうもありがとうございます');
  assert.equal(ja.phonetic, 'Dōmo arigatō gozaimasu');
  assert.equal(ja.sourceText, 'thank you very much');
  assert.equal(ja.targetLang, 'Japanese');
  assert.ok(ja.alternatives?.includes('ありがとうございます'));
});

test('system: CPU %, memory and disk in GB/Go, "out of" / "sur"', () => {
  for (const q of ["Quel est l'état de mon ordinateur", 'Check my computer health']) {
    const s = detect(q).data;
    assert.equal(s.ramUsedGB, 17, q);
    assert.equal(s.ramTotalGB, 18, q);
    assert.equal(s.diskUsedGB, 419, q);
    assert.equal(s.diskTotalGB, 460, q);
  }
  assert.equal(detect("Quel est l'état de mon ordinateur").data.cpuUsage, 68);
  assert.equal(detect('Check my computer health').data.cpuUsage, 44);
});

test('roadmap: "Étape 1 / Week 1" headings become its steps', () => {
  const site = detect('Fais-moi un plan en étapes').data;
  assert.ok(site.tasks.length >= 3);
  assert.match(site.tasks[0].title, /^Cadrage/);
  const rust = detect('Give me a step-by-step plan to learn Rust').data;
  assert.ok(rust.tasks.length >= 4);
  assert.match(rust.tasks[0].title, /^Foundations/);
});

test('chart: a markdown table with French number spaces, "$… billion", dashes', () => {
  const pop = detect("Montre-moi l'évolution de la population de la France de 2015").data;
  assert.equal(pop.chartType, 'line', 'years → a line');
  assert.equal(pop.labels[0], '2015');
  assert.equal(pop.datasets[0].data[0], 66422469);
  assert.ok(pop.labels.length >= 8);
  const apple = detect('Show me the annual revenue of Apple').data;
  assert.deepEqual(apple.datasets[0].data.slice(0, 2), [260.17, 274.52]);
  assert.equal(apple.labels[0], 'FY 2019');
});

test('sports: "won by X. They defeated Y 4–3 on penalties"', () => {
  const f = detect('Who won the last Champions League final').data;
  assert.deepEqual([f.teamA.name, f.teamA.score, f.teamB.name, f.teamB.score], ['Paris Saint-Germain', 4, 'Arsenal', 3]);
  assert.equal(f.status, 'Final · penalties');
  assert.equal(f.league, 'Champions League');
});

test('flight: "15h48 au lieu de 14h35" → actual vs scheduled, delayed', () => {
  const lh = detect('Le vol LH1035').data;
  assert.deepEqual([lh.flightNumber, lh.airline, lh.origin.code, lh.destination.code, lh.status], ['LH1035', 'Lufthansa', 'CDG', 'FRA', 'DELAYED']);
  assert.equal(lh.origin.scheduledTime, '14:35');
  assert.equal(lh.origin.actualTime, '15:48');
  assert.equal(lh.destination.estimatedTime, '16:48');
  assert.equal(lh.destination.scheduledTime, '15:50');
});

test('ordinary answers stay text: no card where there is no card', () => {
  const plain = [
    "Oui, je t'entends parfaitement. Comment puis-je t'aider ?",
    "Bonjour ! Comment puis-je vous aider aujourd'hui ?",
    "J'ai ouvert Safari sur la page d'accueil de Google.",
    'Votre rendez-vous avec Marie est à 14h30 demain, au bureau de Lyon.',
    'La fonction prend 2 arguments et retourne 3 valeurs ; elle utilise la mémoire cache pour éviter de recalculer.',
    "I've created the file report.md with 3 sections: Summary, Details and Next steps.",
    'Done! I set a reminder for 9:00 AM tomorrow to call the bank.',
    'Le projet compte 12 fichiers et 1 200 lignes de code, dont 300 de tests.',
  ];
  const opened = plain.map((t) => [t.slice(0, 40), detectSpecialContent(t)?.type]).filter(([, type]) => type);
  assert.deepEqual(opened, []);
});
