// In-page panel plus the runner that drives Matchplay's own "Add video" form.
// The panel docks left so the game drawer (right) and form (centre) stay visible.
(function () {
  const { parseYouTubeId, parseList, matchRows, describeGame } = globalThis.MPV;
  const RUN_KEY = 'mpvRun';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function until(check, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = check();
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  function ask(message) {
    return chrome.runtime.sendMessage(message).then((res) => {
      if (!res?.ok) throw new Error(res?.error || 'Extension error');
      return res.data;
    });
  }

  const tournamentIdFromUrl = () => {
    const m = location.pathname.match(/^\/tournaments\/(\d+)/);
    return m ? Number(m[1]) : null;
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }

  const clock = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // ---- Driving Matchplay's page -------------------------------------------------

  const byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text);

  const videoInput = () => document.querySelector('input[placeholder^="PASTE video link"]');
  const formDialog = () => videoInput()?.closest('[role=dialog]');
  const formButton = (text) =>
    [...(formDialog()?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text);
  const drawerAddButton = () => byText('li button', 'Add video');

  // React tracks input values itself, so set through the native setter, then fire 'input'.
  function setReactValue(element, proto, value, eventName) {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  }

  function closeDrawer() {
    // Menu items sit in <li>s and video thumbnails are buttons holding an <img>, so the nearest
    // button that is neither is the drawer's close button.
    for (let node = drawerAddButton(); node; node = node.parentElement) {
      const close = node.querySelector('button:not(li button):not(:has(img))');
      if (close) return close.click();
    }
  }

  async function openGame(item) {
    const selector = `a[href$="/matches/${item.gameId}"]`;
    closeDrawer();
    await until(() => !drawerAddButton(), 3000);

    if (!document.querySelector(selector)) {
      const roundSelect = await until(() =>
        [...document.querySelectorAll('select')].find((s) =>
          [...s.options].some((o) => o.value === String(item.roundId))
        )
      );
      if (!roundSelect) throw new Error('Could not find the round selector');
      setReactValue(roundSelect, HTMLSelectElement.prototype, String(item.roundId), 'change');
    }
    const link = await until(() => document.querySelector(selector));
    if (!link) throw new Error(`Game ${item.gameId} is not on the page`);
    link.click();

    const opened = await until(
      () => location.pathname.endsWith(`/matches/${item.gameId}`) && drawerAddButton()
    );
    if (!opened) throw new Error('The game drawer did not open');
  }

  async function addVideo(item, dryRun) {
    await openGame(item);

    // Last check before writing, in case someone added a video since the review list loaded.
    await sleep(500);
    if (!item.allowExisting && byText('div', 'Game video')) return 'skipped';
    if (!item.allowExisting && byText('div', 'Game videos')) return 'skipped';

    drawerAddButton().click();
    const input = await until(videoInput, 5000);
    if (!input) {
      if (document.body.textContent.includes('You must add a streamer tag')) {
        throw new Error('Add a streamer tag in your Matchplay account settings first');
      }
      throw new Error('The Add video form did not open');
    }

    const url = `https://www.youtube.com/watch?v=${item.youtubeId}&t=${item.seconds}`;
    setReactValue(input, HTMLInputElement.prototype, url, 'input');
    const startField = () => formDialog()?.querySelectorAll('input')[1];
    const filled = await until(
      () => input.value === item.youtubeId && startField()?.value === String(item.seconds),
      3000
    );
    const submit = formButton('Add video');
    if (!filled || !submit || submit.disabled) {
      formButton('Cancel')?.click();
      throw new Error('The form did not accept the video link');
    }

    if (dryRun) {
      formButton('Cancel').click();
      await until(() => !videoInput(), 3000);
      return 'rehearsed';
    }

    await setItemStatus(item, 'submitting');
    submit.click();
    if (!(await until(() => !videoInput(), 15000))) {
      const message = formDialog()?.textContent.match(/(?:error|invalid|failed)[^.]*/i)?.[0];
      formButton('Cancel')?.click();
      throw new Error(message || 'Matchplay did not confirm the save');
    }
    return 'added';
  }

  // ---- Run state (survives the page load when moving between tournaments) -----------

  let run = null;
  let stopRequested = false;

  const saveRun = () => chrome.storage.local.set({ [RUN_KEY]: run });

  async function setItemStatus(item, status, note) {
    item.status = status;
    if (note) item.note = note;
    await saveRun();
    render();
  }

  async function executeRun() {
    for (const item of run.items) {
      if (item.status !== 'queued') continue;
      if (stopRequested) {
        run.state = 'stopped';
        break;
      }
      if (item.tournamentId !== tournamentIdFromUrl() || !location.pathname.includes('/matches')) {
        await saveRun();
        location.assign(`/tournaments/${item.tournamentId}/matches`);
        return;
      }
      await setItemStatus(item, 'running');
      try {
        await setItemStatus(item, await addVideo(item, run.dryRun));
      } catch (err) {
        await setItemStatus(item, 'failed', err.message);
        run.state = 'stopped';
        break;
      }
      await sleep(700);
    }
    closeDrawer();
    if (run.state === 'running') run.state = 'done';
    await verifyRun();
    await saveRun();
    render();
  }

  // Check the saves against the API rather than trusting that the form closed.
  async function verifyRun() {
    const added = run.items.filter((i) => i.status === 'added');
    const ids = [...new Set(added.map((i) => i.tournamentId))];
    try {
      for (const id of ids) {
        const videos = await ask({ type: 'load-videos', id });
        for (const item of added.filter((i) => i.tournamentId === id)) {
          item.verified = videos.some(
            (v) => v.gameId === item.gameId && v.youtubeId === item.youtubeId
          );
        }
      }
      run.verifyDone = true;
    } catch {
      run.verifyDone = false;
    }
  }

  function startRun(rows, dryRun) {
    const picked = rows.filter((r) => r.selected && r.game && r.youtubeId);
    // Group by tournament so a run makes at most one page load per tournament.
    const order = [...new Set(picked.map((r) => r.tournament.id))];
    picked.sort((a, b) => order.indexOf(a.tournament.id) - order.indexOf(b.tournament.id));
    run = {
      state: 'running',
      dryRun,
      items: picked.map((r) => ({
        tournamentId: r.tournament.id,
        roundId: r.game.roundId,
        gameId: r.game.gameId,
        youtubeId: r.youtubeId,
        seconds: r.seconds,
        allowExisting: !!r.hasOtherVideo,
        title: `${clock(r.seconds)} ${r.detail.round} · ${r.detail.machine}`,
        status: 'queued',
      })),
    };
    stopRequested = false;
    saveRun();
    render();
    executeRun();
  }

  // ---- Loading -----------------------------------------------------------------------

  let rows = null;
  let tournaments = [];
  let loadError = '';
  let loading = false;
  let urlValue = '';
  let listValue = '';
  let dryRun = false; // lives outside the checkbox, which is rebuilt on every render

  async function loadAll() {
    const currentId = tournamentIdFromUrl();
    if (!currentId) throw new Error('Open a tournament page first');
    let main = await ask({ type: 'load-tournament', id: currentId });
    // Started from a finals page: the qualifying tournament is the main one.
    const qualifying = main.linkedTournaments.find((t) => t.linkType === 'qualifying');
    if (qualifying) main = await ask({ type: 'load-tournament', id: qualifying.tournamentId });
    const linked = [];
    for (const t of main.linkedTournaments) {
      linked.push(await ask({ type: 'load-tournament', id: t.tournamentId }));
    }
    return [main, ...linked];
  }

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const videoId = parseYouTubeId(urlValue);
      let text = listValue;
      if (!text.trim()) {
        if (!videoId) throw new Error('Enter a YouTube link or paste a list');
        text = await ask({ type: 'load-description', videoId });
      }
      const parsed = parseList(text, videoId);
      if (!parsed.length) throw new Error('No timestamped game lines found');
      if (parsed.some((r) => !r.youtubeId)) {
        throw new Error('These lines have no video link. Enter the YouTube link above too.');
      }
      tournaments = await loadAll();
      rows = matchRows(parsed, tournaments);
    } catch (err) {
      loadError = err.message;
    }
    loading = false;
    render();
  }

  // ---- Panel ---------------------------------------------------------------------------

  const host = el('div', { id: 'mpv-root' });
  const shadow = host.attachShadow({ mode: 'open' });
  const view = el('div', { className: 'panel' });
  shadow.append(el('style', { textContent: CSS() }), view);
  let open = false;

  function setOpen(value) {
    open = value;
    if (open && !host.isConnected) document.documentElement.append(host);
    if (!open) host.remove();
    if (open) render();
  }

  const STATUS_TEXT = {
    ready: 'Ready',
    check: 'Check',
    unmatched: 'No match',
    linked: 'Linked',
    queued: 'Waiting',
    running: 'Working…',
    submitting: 'Saving…',
    added: 'Added',
    rehearsed: 'Rehearsed',
    skipped: 'Skipped: has video',
    failed: 'Failed',
    unknown: 'Unknown',
  };

  const badge = (status) =>
    el('span', { className: `badge ${status}`, textContent: STATUS_TEXT[status] || status });

  function gameOptions() {
    const select = el('select', { className: 'pick' }, el('option', { value: '', textContent: 'Choose game…' }));
    tournaments.forEach((t, ti) => {
      const group = el('optgroup', { label: t.name });
      const sorted = [...t.games].sort((a, b) => {
        const ra = t.rounds.find((r) => r.roundId === a.roundId)?.index ?? 0;
        const rb = t.rounds.find((r) => r.roundId === b.roundId)?.index ?? 0;
        return ra - rb || (a.set || 0) - (b.set || 0) || (a.index || 0) - (b.index || 0);
      });
      for (const g of sorted) {
        const d = describeGame(t, g);
        group.append(
          el('option', {
            value: `${ti}:${g.gameId}`,
            textContent: `${d.round} · G${d.group} · ${d.machine} – ${d.players.join(', ')}`,
          })
        );
      }
      select.append(group);
    });
    return select;
  }

  function reviewRow(row) {
    const box = el('input', {
      type: 'checkbox',
      checked: row.selected,
      disabled: !row.game || row.status === 'linked',
      onchange: (e) => {
        row.selected = e.target.checked;
        render();
      },
    });
    const title = row.detail
      ? `${row.detail.round} · G${row.detail.group} · ${row.detail.machine}`
      : row.label
        ? `${row.label.round} · ${row.label.machine}`
        : row.text;
    const body = el(
      'div',
      { className: 'body' },
      el('div', { className: 'title', textContent: title }),
      row.detail ? el('div', { className: 'sub', textContent: row.detail.players.join(', ') }) : null,
      row.note ? el('div', { className: 'note', textContent: row.note }) : null
    );
    if (row.status === 'unmatched') {
      const pick = gameOptions();
      pick.onchange = () => {
        if (!pick.value) return;
        const [ti, gameId] = pick.value.split(':').map(Number);
        const t = tournaments[ti];
        row.tournament = t;
        row.game = t.games.find((g) => g.gameId === gameId);
        row.detail = describeGame(t, row.game);
        row.status = 'ready';
        row.note = 'Picked by hand';
        row.selected = true;
        render();
      };
      body.append(pick);
    }
    return el(
      'label',
      { className: 'row' },
      box,
      el('span', { className: 'time', textContent: clock(row.seconds) }),
      body,
      badge(row.status)
    );
  }

  function renderInput() {
    const url = el('input', {
      type: 'text',
      placeholder: 'https://www.youtube.com/watch?v=…',
      value: urlValue,
      oninput: (e) => (urlValue = e.target.value),
    });
    const list = el('textarea', {
      rows: 6,
      placeholder: 'Optional. Leave empty to read the video description, or paste a list here.',
      value: listValue,
      oninput: (e) => (listValue = e.target.value),
    });
    return [
      el('label', { className: 'field', textContent: 'YouTube video' }, url),
      el('label', { className: 'field', textContent: 'Timestamp list' }, list),
      loadError ? el('div', { className: 'error', textContent: loadError }) : null,
      el('button', {
        className: 'primary',
        textContent: loading ? 'Loading… (up to a minute)' : 'Find games',
        disabled: loading,
        onclick: load,
      }),
    ];
  }

  function renderReview() {
    const selected = rows.filter((r) => r.selected).length;
    const needsLook = rows.filter((r) => r.status === 'check' || r.status === 'unmatched').length;
    const dry = el('input', {
      type: 'checkbox',
      checked: dryRun,
      onchange: (e) => {
        dryRun = e.target.checked;
        render();
      },
    });
    return [
      el('div', {
        className: 'summary',
        textContent: `${rows.length} lines, ${selected} selected${needsLook ? `, ${needsLook} need a look` : ''}`,
      }),
      el('div', { className: 'rows' }, ...rows.map(reviewRow)),
      el(
        'label',
        { className: 'dry' },
        dry,
        el('span', { textContent: 'Rehearse only: fill each form, then cancel' })
      ),
      el(
        'div',
        { className: 'actions' },
        el('button', {
          textContent: 'Back',
          onclick: () => {
            rows = null;
            render();
          },
        }),
        el('button', {
          className: 'primary',
          disabled: !selected,
          textContent: `${dryRun ? 'Rehearse' : 'Add'} ${selected} video${selected === 1 ? '' : 's'}`,
          onclick: () => startRun(rows, dryRun),
        })
      ),
    ];
  }

  function runSummary() {
    const count = (s) => run.items.filter((i) => i.status === s).length;
    if (run.state === 'running') {
      const finished = run.items.filter((i) => !['queued', 'running', 'submitting'].includes(i.status));
      return `${run.dryRun ? 'Rehearsing' : 'Adding'}: ${finished.length} of ${run.items.length}`;
    }
    if (run.dryRun) return `Rehearsal finished: ${count('rehearsed')} of ${run.items.length}. Nothing was saved.`;
    const verified = run.items.filter((i) => i.verified).length;
    const check = run.verifyDone ? `, ${verified} confirmed on Matchplay` : ', could not confirm with Matchplay';
    const lead = run.state === 'stopped' ? 'Stopped' : 'Finished';
    return `${lead}: ${count('added')} of ${run.items.length} added${check}`;
  }

  function renderRun() {
    const active = run.state === 'running';
    return [
      el('div', { className: 'summary', textContent: runSummary() }),
      el(
        'div',
        { className: 'rows' },
        ...run.items.map((item) =>
          el(
            'div',
            { className: 'row' },
            el(
              'div',
              { className: 'body' },
              el('div', { className: 'title', textContent: item.title }),
              item.note ? el('div', { className: 'note', textContent: item.note }) : null,
              item.status === 'added' && item.verified === false
                ? el('div', { className: 'note', textContent: 'Not found on Matchplay after saving' })
                : null
            ),
            badge(item.status)
          )
        )
      ),
      el(
        'div',
        { className: 'actions' },
        active
          ? el('button', {
              textContent: stopRequested ? 'Stopping…' : 'Stop after this game',
              disabled: stopRequested,
              onclick: () => {
                stopRequested = true;
                render();
              },
            })
          : el('button', {
              className: 'primary',
              textContent: 'Done',
              onclick: () => {
                run = null;
                rows = null;
                chrome.storage.local.remove(RUN_KEY);
                render();
              },
            })
      ),
    ];
  }

  function render() {
    if (!open) return;
    const scroller = view.querySelector('.rows');
    const scrollTop = scroller?.scrollTop || 0;
    const content = run ? renderRun() : rows ? renderReview() : renderInput();
    view.replaceChildren(
      el(
        'div',
        { className: 'head' },
        el('strong', { textContent: 'Video Linker' }),
        el('button', { className: 'x', textContent: '×', title: 'Close', onclick: () => setOpen(false) })
      ),
      ...content.filter(Boolean)
    );
    const next = view.querySelector('.rows');
    if (next) next.scrollTop = scrollTop;
  }

  function CSS() {
    return `
      :host { all: initial; }
      .panel { position: fixed; z-index: 2147483647; top: 8px; bottom: 8px; left: 8px; width: 392px;
        display: flex; flex-direction: column; gap: 10px; padding: 12px; box-sizing: border-box;
        background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px;
        font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
      .head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; }
      .x { background: none; border: 0; color: #9ca3af; font-size: 20px; padding: 0 4px; }
      .field { display: flex; flex-direction: column; gap: 4px; color: #9ca3af; }
      input[type=text], textarea, select { background: #1f2937; color: #e5e7eb; border: 1px solid #4b5563;
        border-radius: 6px; padding: 6px 8px; font: inherit; box-sizing: border-box; width: 100%; }
      textarea { resize: vertical; }
      button { background: #374151; color: #e5e7eb; border: 0; border-radius: 6px; padding: 7px 12px;
        font: inherit; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; }
      button.primary { background: #4f46e5; color: #fff; font-weight: 600; }
      .error { color: #fca5a5; }
      .summary { color: #9ca3af; }
      .rows { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
      .row { display: flex; align-items: flex-start; gap: 8px; padding: 6px; background: #1f2937; border-radius: 6px; }
      .time { color: #9ca3af; font-variant-numeric: tabular-nums; min-width: 50px; }
      .body { flex: 1; min-width: 0; }
      .title { font-weight: 600; overflow-wrap: anywhere; }
      .sub { color: #9ca3af; font-size: 12px; }
      .note { color: #fbbf24; font-size: 12px; }
      .pick { margin-top: 4px; }
      .badge { font-size: 11px; padding: 1px 6px; border-radius: 9px; background: #374151; white-space: nowrap; }
      .badge.ready, .badge.added, .badge.linked, .badge.rehearsed { background: #065f46; color: #d1fae5; }
      .badge.check, .badge.skipped, .badge.unknown { background: #78350f; color: #fef3c7; }
      .badge.unmatched, .badge.failed { background: #7f1d1d; color: #fee2e2; }
      .dry { display: flex; gap: 6px; align-items: center; color: #9ca3af; }
      .actions { display: flex; justify-content: space-between; gap: 8px; }
    `;
  }

  // ---- Startup ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'toggle-panel') return;
    if (!open) {
      ask({ type: 'open-youtube-url' })
        .then((url) => {
          if (url && !urlValue) urlValue = url;
          render();
        })
        .catch(() => {});
    }
    setOpen(!open);
  });

  chrome.storage.local.get(RUN_KEY).then((stored) => {
    const saved = stored[RUN_KEY];
    if (!saved) return;
    run = saved;
    setOpen(true);
    if (run.state !== 'running') return;
    // Our own navigation only happens between games, so a game still mid-save here means
    // the page was reloaded during a save. Stop rather than risk adding it twice.
    const interrupted = run.items.find((i) => i.status === 'submitting' || i.status === 'running');
    if (interrupted) {
      interrupted.status = interrupted.status === 'submitting' ? 'unknown' : 'queued';
      if (interrupted.status === 'unknown') {
        interrupted.note = 'Page reloaded during save. Check this game on Matchplay.';
        run.state = 'stopped';
        saveRun();
        render();
        return;
      }
    }
    executeRun();
  });
})();
