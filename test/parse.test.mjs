import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../lib/parse.js';

const { parseList, parseLine, parseTime, parseYouTubeId, matchRows } = globalThis.MPV;
const here = new URL('.', import.meta.url);
const description = readFileSync(new URL('description.txt', here), 'utf8');
const tournaments = () => JSON.parse(readFileSync(new URL('tournaments.json', here), 'utf8'));
const ID = 'MsUegzX0a1c';

test('parses times', () => {
  assert.equal(parseTime('1:36'), 96);
  assert.equal(parseTime('2:39:08'), 9548);
  assert.equal(parseTime('1h2m3s'), 3723);
  assert.equal(parseTime('96s'), 96);
  assert.equal(parseTime('96'), 96);
});

test('reads ids from every link style', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?list=x&v=${ID}&t=5`,
    `https://youtu.be/${ID}?t=96`,
    `https://www.youtube.com/live/${ID}?si=abc`,
  ]) assert.equal(parseYouTubeId(url), ID);
});

test('skips the heading line and keeps all 21 games', () => {
  const rows = parseList(description, ID);
  assert.equal(rows.length, 21);
  assert.equal(rows[0].seconds, 96);
});

test('reads finals prefix, round and group', () => {
  const row = parseLine('3:49:45 A Finals – Finals – Group 10000 · Cleopatra (EM) – Parker P., Indigo I.', ID);
  assert.deepEqual(row.label, {
    tournamentLabel: 'A Finals', round: 'Finals', group: 10000,
    machine: 'Cleopatra (EM)', players: ['Parker P.', 'Indigo I.'],
  });
});

test('a timestamped link carries its own id and time', () => {
  const row = parseLine(`https://youtu.be/${ID}?t=96 Round 1 · Pharaoh – Indigo I.`, '');
  assert.equal(row.youtubeId, ID);
  assert.equal(row.seconds, 96);
  assert.equal(row.label.machine, 'Pharaoh');
});

test('a bare link parses but has no label', () => {
  const [row] = matchRows([parseLine(`https://youtu.be/${ID}?t=96`, '')], tournaments());
  assert.equal(row.status, 'unmatched');
  assert.equal(row.selected, false);
});

test('all 21 real lines match distinct games', () => {
  const rows = matchRows(parseList(description, ID), tournaments());
  const bad = rows.filter((r) => r.status !== 'ready').map((r) => `${r.text} => ${r.note}`);
  assert.deepEqual(bad, []);
  assert.equal(new Set(rows.map((r) => r.game.gameId)).size, 21);
});

test('same machine and round resolves by players', () => {
  const rows = matchRows(parseList(description, ID), tournaments());
  const elPaso = rows.filter((r) => r.label.round === 'Round 5' && r.label.machine === 'El Paso');
  assert.notEqual(elPaso[0].game.gameId, elPaso[1].game.gameId);
});

test('finals lines land in the finals tournament, tiebreaker included', () => {
  const rows = matchRows(parseList(description, ID), tournaments());
  assert.equal(rows.at(-1).tournament.id, 281491);
  assert.equal(rows.at(-1).game.gameId, 8334016);
});

test('the same video on a game is not selected again', () => {
  const data = tournaments();
  data[0].videos = [{ gameId: 8331816, youtubeId: ID }];
  const [row] = matchRows(parseList(description, ID), data);
  assert.equal(row.status, 'linked');
  assert.equal(row.selected, false);
});

test('a different existing video needs a deliberate tick', () => {
  const data = tournaments();
  data[0].videos = [{ gameId: 8331816, youtubeId: 'someOtherId' }];
  const [row] = matchRows(parseList(description, ID), data);
  assert.equal(row.status, 'check');
  assert.equal(row.selected, false);
});

test('a wrong player flags the row instead of guessing silently', () => {
  const rows = parseList('1:36 Round 1 · Pharaoh – Nobody X., Drew D., Finley F., Alex A.', ID);
  const [row] = matchRows(rows, tournaments());
  assert.equal(row.selected, false);
  assert.notEqual(row.status, 'ready');
});
