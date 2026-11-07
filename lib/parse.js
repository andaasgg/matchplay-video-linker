// Pure parsing and matching. No DOM or chrome.* here, so it runs under Node for tests.
//
// Accepted line shapes (label is "<where> · <machine> – <players>"):
//   1:36 Round 1 · Pharaoh – Indigo I., Drew D., Finley F., Alex A.
//   2:39:08 A Finals – Semifinals – Group 2 · Sing Along – Finley F., Harper H.
//   https://youtu.be/MsUegzX0a1c?t=96 Round 1 · Pharaoh – Indigo I., Drew D.
//   https://youtu.be/MsUegzX0a1c?t=96          (no label: pick the game by hand)
(function (root) {
  const DASH = /\s+[–—-]\s+/;

  function parseYouTubeId(text) {
    const m = String(text).match(
      /(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/
    );
    return m ? m[1] : '';
  }

  // "1:02:03", "2:03", "1h2m3s", "90s", "90" -> seconds
  function parseTime(text) {
    const s = String(text).trim();
    if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
      return s.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    }
    const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (!m || !s) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  function parseUrlTime(url) {
    const m = url.match(/[?&#](?:t|start)=([0-9hms]+)/);
    return m ? parseTime(m[1]) : null;
  }

  function parseLabel(text) {
    const dot = text.indexOf(' · ');
    if (dot < 0) return null;
    const where = text.slice(0, dot).trim().split(DASH);
    const what = text.slice(dot + 3).trim().split(DASH);
    if (what.length < 2) return null;

    const groupMatch = where[where.length - 1].match(/^Group\s+(\d+)$/i);
    const group = groupMatch ? Number(groupMatch[1]) : null;
    if (groupMatch) where.pop();

    const round = where.pop();
    if (!round) return null;
    return {
      tournamentLabel: where.join(' ') || null,
      round,
      group,
      // Players come after the last dash, so a machine name may itself contain one.
      machine: what.slice(0, -1).join(' - '),
      players: what[what.length - 1].split(',').map((p) => p.trim()).filter(Boolean),
    };
  }

  function parseLine(line, defaultVideoId) {
    const text = line.trim();
    const url = text.match(/https?:\/\/\S*(?:youtube\.com|youtu\.be)\S*/);
    if (url) {
      const youtubeId = parseYouTubeId(url[0]);
      if (!youtubeId) return null;
      const rest = text.replace(url[0], '').replace(/^[\s:–—-]+/, '').trim();
      return { text, youtubeId, seconds: parseUrlTime(url[0]) ?? 0, label: parseLabel(rest) };
    }
    const stamp = text.match(/^(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/);
    if (!stamp) return null;
    const label = parseLabel(stamp[2]);
    if (!label) return null; // e.g. the "0:00 Carpool Turbo Tuesday" chapter heading
    return { text, youtubeId: defaultVideoId || '', seconds: parseTime(stamp[1]), label };
  }

  function parseList(text, defaultVideoId) {
    return String(text)
      .split(/\r?\n/)
      .map((line) => parseLine(line, defaultVideoId))
      .filter(Boolean)
      .map((row, i) => ({ ...row, id: i }));
  }

  const norm = (s) =>
    String(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  // "Indigo Ivy" and "Indigo I." both become "harrison m".
  function playerKey(name) {
    const words = String(name).trim().split(/\s+/).map(norm).filter(Boolean);
    if (words.length < 2) return words[0] || '';
    return `${words[0]} ${words[words.length - 1][0]}`;
  }

  // Description lines don't always list players in game order, so compare as sets.
  function sameMembers(a, b) {
    const x = [...a].sort();
    const y = [...b].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  function pickTournament(label, tournaments) {
    if (!label) return tournaments[0];
    const want = norm(label);
    return (
      tournaments.find((t) => norm(t.name).startsWith(want)) ||
      tournaments.find((t) => norm(t.name).includes(want)) ||
      null
    );
  }

  function describeGame(t, game) {
    const round = t.rounds.find((r) => r.roundId === game.roundId);
    const arena = t.arenas.find((a) => a.arenaId === game.arenaId);
    const names = game.playerIds.map(
      (id) => t.players.find((p) => p.playerId === id)?.name || `#${id}`
    );
    return {
      round: round?.name || '?',
      group: (game.set || 0) + 1,
      machine: arena?.name || '?',
      players: names,
    };
  }

  function findGame(row, tournaments) {
    const { label } = row;
    if (!label) return { status: 'unmatched', note: 'No game label on this line' };

    const t = pickTournament(label.tournamentLabel, tournaments);
    if (!t) return { status: 'unmatched', note: `No tournament matching "${label.tournamentLabel}"` };

    const round = t.rounds.find((r) => norm(r.name) === norm(label.round));
    if (!round) return { status: 'unmatched', tournament: t, note: `No "${label.round}" in ${t.name}` };

    const arena = t.arenas.find((a) => norm(a.name) === norm(label.machine));
    if (!arena) return { status: 'unmatched', tournament: t, note: `No machine "${label.machine}"` };

    const atMachine = t.games.filter(
      (g) => g.roundId === round.roundId && g.arenaId === arena.arenaId
    );
    const keyOf = (id) => playerKey(t.players.find((p) => p.playerId === id)?.name || '');
    const wanted = label.players.map(playerKey);
    let hits = atMachine.filter((g) => sameMembers(g.playerIds.map(keyOf), wanted));

    if (hits.length > 1 && label.group) {
      hits = hits.filter((g) => (g.set || 0) + 1 === label.group);
    }
    if (hits.length === 1) return { status: 'ready', tournament: t, game: hits[0] };
    if (hits.length > 1) return { status: 'unmatched', tournament: t, note: 'More than one game fits' };
    if (atMachine.length === 1) {
      return {
        status: 'check',
        tournament: t,
        game: atMachine[0],
        note: 'Players differ from this game',
      };
    }
    return { status: 'unmatched', tournament: t, note: 'No game with these players' };
  }

  // tournaments[0] is the main tournament; unprefixed lines ("Round 1 · ...") belong to it.
  function matchRows(rows, tournaments) {
    const seen = new Set();
    return rows.map((row) => {
      const found = findGame(row, tournaments);
      const out = { ...row, ...found };
      if (out.game) {
        out.detail = describeGame(out.tournament, out.game);
        const videos = out.tournament.videos.filter((v) => v.gameId === out.game.gameId);
        if (videos.some((v) => v.youtubeId === row.youtubeId)) {
          out.status = 'linked';
          out.note = 'This video is already on this game';
        } else if (videos.length) {
          out.status = 'check';
          out.note = 'Game already has a different video';
          out.hasOtherVideo = true;
        } else if (seen.has(out.game.gameId)) {
          out.status = 'check';
          out.note = 'Another line matched this same game';
        }
        seen.add(out.game.gameId);
      }
      out.selected = out.status === 'ready';
      return out;
    });
  }

  const api = { parseYouTubeId, parseTime, parseLine, parseList, playerKey, matchRows, describeGame };
  root.MPV = api;
})(globalThis);
