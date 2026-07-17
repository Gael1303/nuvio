/**
 * AnimeZey scraper — SOMENTE FILMES, Nuvio.
 * 100% Promise-based (.then/.catch) — SEM async/await, conforme exigido
 * pelo sandbox Hermes do app (async/await não é executável nos plugins).
 */

const DEBUG = true;
const log = function () {
  if (DEBUG) console.log.apply(console, ['[animezey]'].concat(Array.prototype.slice.call(arguments)));
};

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const MAX_RESULTS = 5;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMDB_API_KEY = '70533e9a93ad18166cb20a576dc62607';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// ---------------------------------------------------------------------------
// Utils (síncronos — sem mudança)
// ---------------------------------------------------------------------------

function removeAccents(text) {
  return (text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeForCompare(text) {
  if (!text) return '';
  const ascii = removeAccents(String(text)).toLowerCase();
  return ascii.replace(/[^a-z0-9]/g, '');
}

function guessQualityFromName(name) {
  // Retorna NÚMERO (1080, 720, etc.), não string — confirmado no fshd.js
  // real ('quality': 0x438 === 1080), inclusive usado em ordenação
  // numérica (b.quality - a.quality).
  if (!name) return 480;
  const n = name.toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return 2160;
  if (n.includes('1080p') || n.includes('fullhd') || n.includes('full hd')) return 1080;
  if (n.includes('720p')) return 720;
  if (['hdtv', 'webdl', 'web-dl', 'webrip', 'hdrip', 'bluray', 'bdrip'].some(function (t) { return n.includes(t); })) return 720;
  if (['dvdrip', 'sd', '480p', 'tvrip'].some(function (t) { return n.includes(t); })) return 480;
  return 720;
}

function formatSize(sizeBytes) {
  try {
    const b = Number(sizeBytes);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  } catch (e) {
    return 'N/A';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TITLE_END_RE = new RegExp(
  '^(?:' +
    '\\[?\\d{3,4}p\\]?' +
    '|(?:19|20)\\d{2}' +
    '|\\[(?:dual|dub|leg|sub|pt[\\-.]br|bluray|bdrip|webrip' +
      '|web[\\-.]dl|hdtv|x264|x265|hevc|aac|mkv|mp4|avi|wmv|mov)\\]' +
    '|(?:dual|dub|leg|sub|pt[\\-.]br|bluray|bdrip|webrip' +
      '|web[\\-.]dl|hdtv|x264|x265|hevc|aac|mkv|mp4|avi|wmv|mov)' +
  ')',
  'i'
);

const IGNORABLE_PREFIX_WORDS = new Set([
  'the', 'a', 'an', 'o', 'os', 'as', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'um', 'uma',
]);

const NOISE_WORD_RE = new RegExp(
  '^(?:\\d{4}|[a-z0-9]+(?:p|k)|bluray|bdrip|webrip|web|hdtv' +
  '|x264|x265|hevc|aac|mkv|mp4|avi|wmv|mov|hdr|sdr|remux' +
  '|dual|dub|dublado|leg|legendado|sub|pt[\\-.]?br' +
  '|nf|netflix|hbo|max|hbomax|disney|disneyplus|amazon|prime' +
  '|paramount|peacock|hulu|apple|appletv|star|globoplay' +
  '|telecine|crunchyroll|funimation|youtube|vix|pluto' +
  '|copia|copy|sample|extras?)$',
  'i'
);

// ---------------------------------------------------------------------------
// HTTP — 100% Promise-chain, sem await
// ---------------------------------------------------------------------------

function fetchWithTimeout(url, options) {
  // Sandbox confirmado sem setTimeout/AbortController — sem eles não dá
  // pra implementar timeout manual, então só faz o fetch puro. As chamadas
  // de rede simplesmente resolvem ou rejeitam pelo comportamento normal
  // do fetch, sem cancelamento por tempo.
  return fetch(url, options || {});
}

function withRetry(fn, maxRetries, attempt) {
  maxRetries = maxRetries || MAX_RETRIES;
  attempt = attempt || 0;

  return fn().catch(function (e) {
    const isRetryable = e.name === 'AbortError' || e.name === 'TypeError';
    if (attempt >= maxRetries - 1 || !isRetryable) throw e;
    // Sem setTimeout disponível não dá pra esperar entre tentativas —
    // tenta de novo imediatamente.
    return withRetry(fn, maxRetries, attempt + 1);
  });
}

function postToAnimezey(url, payload) {
  return withRetry(function () {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        Referer: url,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }).catch(function (e) {
    log('Erro POST ' + url + ':', e.message);
    return null;
  });
}

function fetchTmdbMovie(tmdbId) {
  const url = TMDB_BASE + '/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=pt-BR';
  return fetchWithTimeout(url).then(function (res) {
    if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// Scraper (só filmes) — métodos retornam Promise, sem async/await
// ---------------------------------------------------------------------------

function AnimeZeyMovieScraper(providerUrl, itemData) {
  this.providerUrl = providerUrl;
  this.title = (itemData.title || '').trim();
  this.originalTitle = (itemData.original_title || '').trim();
  this.year = itemData.year || null;
  this._setupDomains();
  log('🎯 Busca filme: \'' + this.title + '\' (' + this.year + ')');
}

AnimeZeyMovieScraper.prototype._setupDomains = function () {
  let netloc = '1.animezey23112022.workers.dev';
  try {
    netloc = new URL(this.providerUrl).host || netloc;
  } catch (e) { /* mantém default */ }
  this.baseDomain = netloc;
  this.downloadDomain = 'animezey16082023.animezey16082023.workers.dev';
};

AnimeZeyMovieScraper.prototype.scrape = function () {
  const self = this;
  return this._searchMovies().catch(function (e) {
    log('❌ Erro:', e.message);
    return [];
  });
};

AnimeZeyMovieScraper.prototype._searchMovies = function () {
  const self = this;
  const seenIds = new Set();
  const movies = [];
  const queries = this._generateMovieQueries().slice(0, 8);
  const searchUrl = 'https://' + this.baseDomain + '/1:search';

  log('[_searchMovies] ' + queries.length + ' queries geradas: ' + JSON.stringify(queries));

  function processQuery(query) {
    if (movies.length >= MAX_RESULTS) return Promise.resolve();
    return postToAnimezey(searchUrl, { q: query }).then(function (result) {
      const fileCount = result && result.data && result.data.files ? result.data.files.length : 0;
      log('[_searchMovies] query="' + query + '" -> ' + fileCount + ' arquivo(s) na resposta');
      if (!result || !result.data || !result.data.files) return;
      const files = result.data.files;
      for (let i = 0; i < files.length; i++) {
        if (movies.length >= MAX_RESULTS) break;
        const item = files[i];
        const itemId = item.id;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        const isVideo = self._isVideoFile(item);
        const isCorrect = self._isCorrectMovie(item.name || '');
        log('[_searchMovies] candidato: "' + item.name + '" isVideo=' + isVideo + ' isCorrect=' + isCorrect);
        if (isVideo && isCorrect) {
          movies.push(item);
        }
      }
    });
  }

  return queries.reduce(function (p, query) {
    return p.then(function () { return processQuery(query); });
  }, Promise.resolve()).then(function () {
    log('[_searchMovies] total de filmes casados: ' + movies.length);
    return movies.length ? self._processResults(movies) : [];
  });
};

AnimeZeyMovieScraper.prototype._generateMovieQueries = function () {
  const queries = [];
  const baseNames = this._getBaseNames().slice(0, 5);
  const self = this;

  baseNames.forEach(function (name) {
    let clean = removeAccents(name.replace(/['".:]/g, ''));
    clean = clean.replace(/\s*-\s*/g, ' ').trim();
    const dots = clean.replace(/ /g, '.');
    if (self.year) {
      queries.push(dots + '.' + self.year);
      queries.push(clean + ' ' + self.year);
    }
    queries.push(dots);
    queries.push(clean);
  });

  if (this.originalTitle) {
    const rawOrig = this.originalTitle.replace(/['".\-]/g, '').trim();
    if (this.year) queries.push(rawOrig + ' ' + this.year);
    queries.push(rawOrig);
  }

  return Array.from(new Set(queries.filter(Boolean)));
};

AnimeZeyMovieScraper.prototype._getBaseNames = function () {
  const names = [];
  [this.title, this.originalTitle].forEach(function (field) {
    if (!field) return;
    const clean = field.trim();
    if (names.indexOf(clean) === -1) names.push(clean);
    if (clean.includes(':')) {
      const short = clean.split(':')[0].trim();
      if (names.indexOf(short) === -1) names.push(short);
    }
  });

  const final = [];
  names.forEach(function (name) {
    final.push(name);
    if (name.includes("'")) final.push(name.replace(/'/g, ''));
    const lower = name.toLowerCase();
    const articles = ['the ', 'a ', 'an ', 'o ', 'os ', 'as '];
    for (let i = 0; i < articles.length; i++) {
      if (lower.startsWith(articles[i])) {
        const rest = name.slice(articles[i].length);
        if (final.indexOf(rest) === -1) final.push(rest);
        break;
      }
    }
  });

  return Array.from(new Set(final.filter(Boolean)));
};

AnimeZeyMovieScraper.prototype._normalizeFn = function (s) {
  let out = removeAccents((s || '').toLowerCase());
  out = out.replace(/[.\-_+,:]/g, ' ');
  out = out.replace(/[[\](){}]/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
};

AnimeZeyMovieScraper.prototype._titleMatch = function (title, filename) {
  const titleN = this._normalizeFn(title);
  const fnN = this._normalizeFn(filename);
  if (!titleN) return false;

  const pattern = new RegExp('(?<![a-z0-9])' + escapeRegExp(titleN) + '(?=[^a-z0-9]|$)', 'g');

  let m;
  while ((m = pattern.exec(fnN)) !== null) {
    const after = fnN.slice(m.index + titleN.length).trim();
    const afterOk = !after || TITLE_END_RE.test(after) || /^[\-\u2013\u2014]?\s*\d/.test(after);
    if (!afterOk) continue;

    const before = fnN.slice(0, m.index).trim();
    if (!before) return true;

    const contentWords = before.split(/\s+/).filter(Boolean).filter(function (w) {
      return !NOISE_WORD_RE.test(w) && !IGNORABLE_PREFIX_WORDS.has(w);
    });
    if (!contentWords.length) return true;
  }
  return false;
};

AnimeZeyMovieScraper.prototype._isCorrectMovie = function (filename) {
  const baseNames = this._getBaseNames();
  const fnLower = filename.toLowerCase();
  const fnNorm = normalizeForCompare(removeAccents(fnLower));
  const self = this;

  for (let i = 0; i < baseNames.length; i++) {
    const name = baseNames[i];
    const nameAscii = removeAccents(name);
    const nameNorm = normalizeForCompare(nameAscii);
    const matched = self._titleMatch(nameAscii, fnLower) || self._titleMatch(nameNorm, fnNorm);
    if (matched) {
      return self.year ? fnLower.includes(String(self.year)) : true;
    }
  }
  return false;
};

AnimeZeyMovieScraper.prototype._isVideoFile = function (item) {
  const name = (item.name || '').toLowerCase();
  const mime = item.mimeType || '';
  return mime.includes('video') || /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/.test(name);
};

AnimeZeyMovieScraper.prototype._processResults = function (items) {
  const self = this;
  const results = [];
  const seenLinks = new Set();

  function processItem(item) {
    return self._extractPlayerUrl(item).then(function (url) {
      if (!url || seenLinks.has(url)) return;
      seenLinks.add(url);
      results.push(self._createResultItem(item, url));
    });
  }

  return items.reduce(function (p, item) {
    return p.then(function () { return processItem(item); });
  }, Promise.resolve()).then(function () {
    // Ordenação numérica confirmada no fshd.js real: b.quality - a.quality
    results.sort(function (a, b) { return b.quality - a.quality; });
    return results;
  });
};

AnimeZeyMovieScraper.prototype._extractPlayerUrl = function (item) {
  const self = this;
  const linkPart = item.link || '';
  if (!linkPart) return Promise.resolve(null);

  if (linkPart.includes('/download.aspx')) {
    return Promise.resolve(this._buildDownloadLink(linkPart));
  }

  let viewUrl = 'https://' + this.baseDomain + linkPart;
  if (!viewUrl.includes('a=view')) {
    viewUrl += viewUrl.includes('?') ? '&a=view' : '?a=view';
  }

  return fetchWithTimeout(viewUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Referer: 'https://' + this.baseDomain + '/',
    },
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then(function (html) {
    const srcMatch = html.match(/<source[^>]+src=["']([^"']+)["']/i);
    if (srcMatch) return srcMatch[1];
    return self._buildDownloadLink(linkPart);
  }).catch(function (e) {
    log('❌ Erro ao extrair URL do player:', e.message);
    return self._buildDownloadLink(item.link);
  });
};

AnimeZeyMovieScraper.prototype._buildDownloadLink = function (linkPart) {
  if (!linkPart || linkPart.charAt(0) !== '/') return null;
  try {
    const splitIdx = linkPart.indexOf('?');
    const pathPart = splitIdx === -1 ? linkPart : linkPart.slice(0, splitIdx);
    const queryString = splitIdx === -1 ? '' : linkPart.slice(splitIdx + 1);
    const params = new URLSearchParams(queryString);
    const fileId = params.get('file');
    if (!fileId) return null;

    const outParams = new URLSearchParams({ file: fileId });
    ['expiry', 'mac'].forEach(function (key) {
      const val = params.get(key);
      if (val) outParams.set(key, val);
    });

    return 'https://' + this.downloadDomain + pathPart + '?' + outParams.toString();
  } catch (e) {
    log('⚠️ Erro construindo link fallback:', e.message);
    return null;
  }
};

AnimeZeyMovieScraper.prototype._createResultItem = function (fileData, downloadUrl) {
  const fileName = fileData.name || '';
  const quality = guessQualityFromName(fileName); // número: 2160/1080/720/480
  const fnLower = fileName.toLowerCase();

  let language;
  if (['dual', 'multi'].some(function (x) { return fnLower.includes(x); })) language = 'DUAL';
  else if (['dublado', 'dub ', 'pt-br'].some(function (x) { return fnLower.includes(x); })) language = 'PT-BR';
  else if (['legendado', 'leg', 'sub', 'eng'].some(function (x) { return fnLower.includes(x); })) language = 'LEG';
  else language = 'PT-BR';

  return {
    // Campos confirmados no schema real (fshd.js): name, title, url,
    // quality (número), group, provider, headers.
    name: 'AnimeZey ' + language + ' ' + quality + 'p',
    title: fileName,
    url: downloadUrl,
    quality: quality,
    group: language,
    provider: 'AnimeZey',
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://' + this.baseDomain + '/' },
    // Campos extras (não confirmados no schema, mas inofensivos de manter)
    size: formatSize(fileData.size || 0),
  };
};

// ---------------------------------------------------------------------------
// Entry point — assinatura padrão Nuvio, 100% Promise-based
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType, providerUrl) {
  function debugError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    log('[getStreams] ❌ Erro:', msg);
    return [{
      name: 'AnimeZey [ERRO]',
      title: 'DEBUG: ' + msg,
      url: 'https://example.com/erro-debug',
      quality: 0,
      group: 'DEBUG',
      provider: 'AnimeZey',
      headers: {},
    }];
  }

  try {
    providerUrl = providerUrl || 'https://1.animezey23112022.workers.dev';
    log('[getStreams] chamado com tmdbId=' + tmdbId + ' mediaType=' + mediaType);

    if (mediaType !== 'movie') {
      log('[getStreams] mediaType != movie, retornando vazio');
      return Promise.resolve([]);
    }

    return fetchTmdbMovie(tmdbId).then(function (details) {
      log('[getStreams] TMDB OK: title=' + details.title + ' original=' + details.original_title);
      const dateStr = details.release_date || '';
      const itemData = {
        title: details.title,
        original_title: details.original_title,
        year: dateStr ? parseInt(dateStr.slice(0, 4), 10) : null,
      };
      const scraper = new AnimeZeyMovieScraper(providerUrl, itemData);
      return scraper.scrape().then(function (results) {
        log('[getStreams] scrape() retornou ' + results.length + ' resultado(s)');
        return results;
      });
    }).catch(debugError);
  } catch (e) {
    // Captura qualquer erro SÍNCRONO (ex: API ausente no sandbox) que
    // aconteceria antes mesmo de existir uma Promise pra encadear .catch.
    return Promise.resolve(debugError(e));
  }
}

// Export CommonJS (formato exigido pelo Nuvio)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
