// Service worker: toolbar click, plus the cross-origin reads the page can't do itself.
// Everything here is read-only. Writes happen only through Matchplay's own form (content.js).

const API = 'https://api.matchplay.events/api';

chrome.action.onClicked.addListener((tab) => {
  // No content script on non-Matchplay tabs; there's nothing to toggle there.
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/${path}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After')) || 15;
      await sleep(Math.min(wait, 60) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Matchplay API returned ${res.status} for ${path}`);
    return (await res.json()).data;
  }
  throw new Error('Matchplay API is rate limiting requests. Try again in a minute.');
}

async function loadTournament(id) {
  const t = await apiGet(
    `tournaments/${id}?includePlayers=1&includeArenas=1&includeVideos=1&includeLinkedTournaments=1`
  );
  const rounds = await apiGet(`tournaments/${id}/rounds`);
  const games = await apiGet(`tournaments/${id}/games`);
  return {
    id: t.tournamentId,
    name: t.name,
    linkedTournaments: t.linkedTournaments || [],
    players: t.players || [],
    arenas: t.arenas || [],
    videos: t.videos || [],
    rounds,
    games,
  };
}

async function loadVideos(id) {
  const t = await apiGet(`tournaments/${id}?includeVideos=1`);
  return t.videos || [];
}

async function loadDescription(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`YouTube returned ${res.status}`);
  const html = await res.text();
  const m = html.match(/"shortDescription":("(?:[^"\\]|\\.)*")/);
  if (!m) throw new Error('Could not find the description. Paste the list instead.');
  return JSON.parse(m[1]);
}

async function openYouTubeUrl() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  return tabs.length === 1 ? tabs[0].url : '';
}

const handlers = {
  'load-tournament': (msg) => loadTournament(msg.id),
  'load-videos': (msg) => loadVideos(msg.id),
  'load-description': (msg) => loadDescription(msg.videoId),
  'open-youtube-url': () => openYouTubeUrl(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // keep the channel open for the async response
});
