/*
 * Random-moment YouTube playlist page.
 *
 * On load (and on Shuffle) we pick a random video from a fixed playlist and a
 * random timestamp from that video's description, skipping anything labelled
 * "intro" or "outro", then load the IFrame player PAUSED at that offset.
 *
 * The embed/IFrame API can't read descriptions, so we use the YouTube Data
 * API v3 directly from the browser (key lives in the gitignored config.js).
 * The built dataset is cached in localStorage so loads/shuffles are free.
 */
(function () {
  'use strict';

  // --- Constants -----------------------------------------------------------
  var PLAYLISTS = {
    all: 'PL6W47aln8JRfkyR_Bf19Nt63DElvTkB11',
    pz1: 'PL6W47aln8JRfFKSliFezfztzIV37IYZX2',
    pz2: 'PL6W47aln8JReWv9CKD5OjmBu1-bvAR8sK'
  };
  var selectedPlaylist = 'all';
  var API_BASE = 'https://www.googleapis.com/youtube/v3';
  var CACHE_KEY = 'ytrand:dataset:v1';
  var TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  var PLACEHOLDER = 'YOUR_API_KEY_HERE';

  // A timestamp line: optional "-"/bullet, optional H:, then MM:SS, optional
  // separator, then the label. Matches "0:00 Intro", "1:23 - Topic",
  // "1:02:33 Later topic".
  var TS_RE = /^\s*[-–—•]?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b\s*[-–—:.)]?\s*(.+?)\s*$/;
  // Exclude only the standalone words "intro"/"outro" (keeps "Introduction").
  var INTRO_OUTRO = /\b(?:intro|outro)\b/i;

  // --- State ---------------------------------------------------------------
  var pool = [];          // [{ id, title, timestamps: [{ seconds, label }] }]
  var player = null;
  var current = null;     // { videoId, title, label, seconds }
  var apiReady = false;
  var animalOverrides = {};
  var headlineOverrides = {};
  var pendingSelection = null; // selection waiting for the IFrame API to load
  var pendingAutoplay = false; // whether that pending selection should autoplay
  var lastAutoplay = false;    // autoplay intent of the current selection

  // --- DOM -----------------------------------------------------------------
  var statusEl, headlineEl, shuffleBtn, playlistToggleButtons, forceRefreshQuery = false;

  function cacheDom() {
    statusEl = document.getElementById('status');
    headlineEl = document.getElementById('headline');
    shuffleBtn = document.getElementById('shuffle');
    playlistToggleButtons = document.querySelectorAll('[data-playlist]');

    playlistToggleButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setPlaylist(button.dataset.playlist);
      });
    });
  }

  function setStatus(msg, cls) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = cls || '';
    statusEl.hidden = false;
  }

  function clearStatus() {
    if (!statusEl) return;
    statusEl.textContent = '';
    statusEl.className = '';
    statusEl.hidden = true;
  }

  // --- Helpers -------------------------------------------------------------
  function apiKey() {
    return (window.YT_CONFIG && window.YT_CONFIG.API_KEY) || '';
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function normalizeTitle(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
  }

  function loadAnimalOverrides() {
    return fetch('../animal-overrides.json', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) {
          animalOverrides = {};
          headlineOverrides = {};
          return;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') {
          animalOverrides = {};
          headlineOverrides = {};
          return;
        }

        if (data.animalOverrides || data.headlineOverrides) {
          animalOverrides = data.animalOverrides && typeof data.animalOverrides === 'object' ? data.animalOverrides : {};
          headlineOverrides = data.headlineOverrides && typeof data.headlineOverrides === 'object' ? data.headlineOverrides : {};
          return;
        }

        animalOverrides = data;
        headlineOverrides = {};
      })
      .catch(function () {
        animalOverrides = {};
        headlineOverrides = {};
      });
  }

  function lookupTitleOverrideMap(map, title) {
    if (!map || typeof map !== 'object') return '';
    var normalized = normalizeTitle(title);
    return map[normalized] || map[normalized.toLowerCase()] || '';
  }

  // Video titles look like "<N> Real <Animal> Habitat(s)! (...)" -> <Animal>.
  function animalFromTitle(title) {
    var overrideValue = lookupTitleOverrideMap(animalOverrides, title);
    if (overrideValue) return String(overrideValue).trim();

    var normalized = normalizeTitle(title);
    var m = /\bReal\s+(.+?)\s+Habitats?\b/i.exec(normalized);
    return m ? m[1].trim() : '';
  }

  function customHeadlineFromTitle(title) {
    var overrideValue = lookupTitleOverrideMap(headlineOverrides, title);
    if (!overrideValue) return '';
    return 'Feeling stuck? Try building this ' + String(overrideValue).trim() + ' from ' + current.label + '!';
  }

  // --- Timestamp parsing ---------------------------------------------------
  function parseTimestamps(description) {
    var out = [];
    var lines = (description || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = TS_RE.exec(lines[i]);
      if (!m) continue;
      var h = m[1] ? parseInt(m[1], 10) : 0;
      var mm = parseInt(m[2], 10);
      var ss = parseInt(m[3], 10);
      if (ss > 59) continue; // not a real timestamp
      var label = m[4].trim();
      if (!label) continue;
      out.push({ seconds: h * 3600 + mm * 60 + ss, label: label });
    }
    return out;
  }

  function eligible(timestamps) {
    return timestamps.filter(function (t) { return !INTRO_OUTRO.test(t.label); });
  }

  // --- Data layer (YouTube Data API v3) ------------------------------------
  function apiGet(path, params) {
    var url = new URL(API_BASE + path);
    Object.keys(params).forEach(function (k) { url.searchParams.set(k, params[k]); });
    url.searchParams.set('key', apiKey());
    return fetch(url.toString()).then(function (res) {
      if (res.ok) return res.json();
      return res.json().catch(function () { return null; }).then(function (body) {
        var reason = '';
        if (body && body.error) {
          reason = (body.error.errors && body.error.errors[0] && body.error.errors[0].reason) ||
                   body.error.message || '';
        }
        var err = new Error('HTTP ' + res.status + (reason ? ' (' + reason + ')' : ''));
        err.status = res.status;
        err.reason = reason;
        throw err;
      });
    });
  }

  function fetchPlaylistVideoIds(playlistId) {
    var ids = [];
    var targetPlaylistId = playlistId || currentPlaylistId();
    function page(pageToken) {
      var params = { part: 'contentDetails', playlistId: targetPlaylistId, maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      return apiGet('/playlistItems', params).then(function (data) {
        (data.items || []).forEach(function (item) {
          var id = item.contentDetails && item.contentDetails.videoId;
          if (id) ids.push(id);
        });
        if (data.nextPageToken) return page(data.nextPageToken);
        return ids;
      });
    }
    return page('');
  }

  function fetchVideoSnippets(ids) {
    var out = [];
    function batch(i) {
      if (i >= ids.length) return out;
      var chunk = ids.slice(i, i + 50); // videos.list accepts up to 50 ids
      return apiGet('/videos', { part: 'snippet', id: chunk.join(',') }).then(function (data) {
        (data.items || []).forEach(function (item) {
          out.push({
            id: item.id,
            title: (item.snippet && item.snippet.title) || '(untitled)',
            description: (item.snippet && item.snippet.description) || ''
          });
        });
        return batch(i + 50);
      });
    }
    return Promise.resolve(batch(0));
  }

  function buildDataset() {
    return fetchPlaylistVideoIds(currentPlaylistId())
      .then(fetchVideoSnippets)
      .then(function (videos) {
        var dataset = [];
        videos.forEach(function (v) {
          var elig = eligible(parseTimestamps(v.description));
          if (elig.length > 0) dataset.push({ id: v.id, title: v.title, timestamps: elig });
        });
        return dataset;
      });
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function bindCarouselControls() {
    document.querySelectorAll('.carousel-button[data-carousel-scroll]').forEach(function (button) {
      button.addEventListener('click', function () {
        var carousel = document.getElementById('pz-inspiration-carousel');
        if (!carousel) return;
        var shift = carousel.clientWidth * 0.8;
        var direction = Number(button.dataset.carouselScroll) || 1;
        carousel.scrollBy({ left: shift * direction, behavior: 'smooth' });
      });
    });
  }

  function renderPlaylistCarousel(videos) {
    var root = document.getElementById('pz-inspiration-carousel');
    if (!root) return;
    if (!videos.length) {
      root.innerHTML = '<div class="playlist-carousel__empty">No videos found.</div>';
      return;
    }
    root.innerHTML = videos.map(function (video) {
      return '<a class="playlist-card" href="https://www.youtube.com/watch?v=' + encodeURIComponent(video.id) + '" target="_blank" rel="noopener" aria-label="Open ' + escapeHtml(video.title) + '">' +
        '<img class="playlist-card__thumb" src="https://i.ytimg.com/vi/' + encodeURIComponent(video.id) + '/hqdefault.jpg" alt="' + escapeHtml(video.title) + '" loading="lazy" />' +
        '<div class="playlist-card__meta"><span>Video</span><strong>' + escapeHtml(video.title) + '</strong></div>' +
        '</a>';
    }).join('');
  }

  function loadPlaylistCarousel() {
    var root = document.getElementById('pz-inspiration-carousel');
    if (!root) return;
    root.innerHTML = '<div class="playlist-carousel__loading">Loading videos…</div>';
    fetchPlaylistVideoIds('PL6W47aln8JRfkyR_Bf19Nt63DElvTkB11')
      .then(fetchVideoSnippets)
      .then(function (videos) {
        var seen = {};
        var ordered = [];
        videos.forEach(function (video) {
          if (!video || !video.id || seen[video.id]) return;
          seen[video.id] = true;
          ordered.push(video);
        });
        renderPlaylistCarousel(ordered);
        bindCarouselControls();
      })
      .catch(function (e) {
        root.innerHTML = '<div class="playlist-carousel__error">Unable to load videos right now.</div>';
      });
  }

  // --- Cache ---------------------------------------------------------------
  function loadCache() {
    try {
      var raw = localStorage.getItem(getCacheKey());
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.builtAt || !Array.isArray(obj.data)) return null;
      if (Date.now() - obj.builtAt > TTL_MS) return null;
      return obj.data;
    } catch (e) { return null; }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(getCacheKey(), JSON.stringify({ builtAt: Date.now(), data: data }));
    } catch (e) { /* storage full/blocked — fine, just skip caching */ }
  }

  function getDataset(forceRefresh) {
    if (!forceRefresh) {
      var cached = loadCache();
      if (cached) return Promise.resolve(cached);
    }
    return buildDataset().then(function (data) { saveCache(data); return data; });
  }

  function currentPlaylistId() {
    return PLAYLISTS[selectedPlaylist];
  }

  function getCacheKey() {
    return CACHE_KEY + ':' + selectedPlaylist;
  }

  function setPlaylistButtons() {
    playlistToggleButtons.forEach(function (button) {
      var active = button.dataset.playlist === selectedPlaylist;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setPlaylist(playlistKey) {
    if (!PLAYLISTS.hasOwnProperty(playlistKey) || playlistKey === selectedPlaylist) return;
    selectedPlaylist = playlistKey;
    setPlaylistButtons();
    loadPlaylist();
  }

  function loadPlaylist() {
    setStatus('Loading playlist…', 'loading');
    shuffleBtn.disabled = true;
    pool = [];
    current = null;
    setPlaylistButtons();

    getDataset(forceRefreshQuery).then(function (data) {
      pool = data || [];
      if (pool.length === 0) {
        setStatus('No videos in this playlist have usable (non-intro/outro) timestamps.', 'error');
        return;
      }
      clearStatus();
      shuffleBtn.disabled = false;
      if (!apiReady) loadIframeApi();
      applySelection(chooseSelection(null), false);
    }).catch(function (e) {
      if (e.status === 400 || e.status === 403) {
        setStatus('YouTube API request rejected (' + e.status +
          (e.reason ? ' · ' + e.reason : '') + '). Check that config.js has a ' +
          'valid YouTube Data API v3 key, that the API is enabled, that the ' +
          'key\'s HTTP-referrer restriction allows this origin, and that you ' +
          'are within quota.', 'error');
      } else {
        setStatus('Failed to load playlist data: ' + e.message, 'error');
      }
    });
  }

  // --- Selection + player --------------------------------------------------
  function chooseSelection(excludeId) {
    var candidates = pool;
    if (excludeId && pool.length > 1) {
      candidates = pool.filter(function (v) { return v.id !== excludeId; });
    }
    if (candidates.length === 0) return null;
    var video = pickRandom(candidates);
    var ts = pickRandom(video.timestamps);
    return { videoId: video.id, title: video.title, label: ts.label, seconds: ts.seconds };
  }

  function updateHeadline() {
    if (!current) { headlineEl.textContent = 'Feeling stuck?'; return; }

    var customHeadline = customHeadlineFromTitle(current.title);
    if (customHeadline) {
      headlineEl.textContent = customHeadline;
      return;
    }

    // "Feeling stuck? Try building the <Animal> habitat of <Zoo>!", where Zoo
    // is the chapter label (the text after the timestamp).
    var animal = animalFromTitle(current.title);
    headlineEl.textContent = animal
      ? 'Feeling stuck? Try building the ' + animal + ' habitat of ' + current.label + '!'
      : 'Feeling stuck? Try building this habitat from ' + current.label + '!';
  }

  // autoplay: true to load+play at the offset (used for Shuffle, where the call
  // runs inside the click gesture so autoplay-with-sound is allowed); false to
  // cue PAUSED at the offset (initial page load and error recovery).
  function applySelection(sel, autoplay) {
    current = sel;
    lastAutoplay = !!autoplay;
    window.__selection = sel; // exposed for tests
    updateHeadline();
    if (!player) {
      if (!apiReady) { pendingSelection = sel; pendingAutoplay = !!autoplay; return; }
      createPlayer(sel, autoplay);
      return;
    }
    if (autoplay) {
      player.loadVideoById({ videoId: sel.videoId, startSeconds: sel.seconds });
    } else {
      player.cueVideoById({ videoId: sel.videoId, startSeconds: sel.seconds });
    }
  }

  function createPlayer(sel, autoplay) {
    player = new YT.Player('player-mount', {
      width: '100%',
      height: '100%',
      videoId: sel.videoId,
      playerVars: {
        start: sel.seconds,
        autoplay: autoplay ? 1 : 0,
        rel: 0,
        enablejsapi: 1,
        origin: location.origin
      },
      events: { onReady: onPlayerReady, onError: onPlayerError }
    });
    window.__player = player; // exposed for tests
  }

  function onPlayerReady() {
    window.__playerReady = true; // exposed for tests
  }

  function onPlayerError(e) {
    // 2 bad param · 5 html5 · 100 removed · 101/150 embedding disabled.
    var unplayable = [2, 5, 100, 101, 150];
    if (unplayable.indexOf(e.data) === -1 || !current) return;
    pool = pool.filter(function (v) { return v.id !== current.videoId; });
    if (pool.length === 0) {
      setStatus('No playable videos remain in the playlist.', 'error');
      return;
    }
    // Keep the current autoplay intent: a failed page-load pick stays paused,
    // a failed Shuffle pick keeps trying with autoplay.
    var sel = chooseSelection(current.videoId);
    if (sel) applySelection(sel, lastAutoplay);
  }

  function shuffle() {
    if (pool.length === 0) return;
    var sel = chooseSelection(current ? current.videoId : null);
    if (sel) applySelection(sel, true); // user asked for another -> autoplay
  }

  // --- IFrame API bootstrap ------------------------------------------------
  window.onYouTubeIframeAPIReady = function () {
    apiReady = true;
    if (pendingSelection) {
      createPlayer(pendingSelection, pendingAutoplay);
      pendingSelection = null;
    }
  };

  function loadIframeApi() {
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  // --- Init ----------------------------------------------------------------
  function init() {
    cacheDom();

    if (document.getElementById('pz-inspiration-carousel')) {
      loadPlaylistCarousel();
    }

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', shuffle);
    }

    if (!document.getElementById('status') && !document.getElementById('headline')) {
      return;
    }

    var key = apiKey();
    if (!key || key === PLACEHOLDER) {
      setStatus('Setup needed: copy config.example.js to config.js and add your ' +
        'YouTube Data API key. See README.md.', 'setup');
      return;
    }

    if (!playlistToggleButtons || playlistToggleButtons.length === 0) {
      return;
    }

    forceRefreshQuery = new URLSearchParams(location.search).get('refresh') === '1';
    setPlaylistButtons();
    loadAnimalOverrides().then(function () {
      loadPlaylist();
    }).catch(function () {
      loadPlaylist();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
