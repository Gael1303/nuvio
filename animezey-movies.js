/**
 * AnimeZey scraper — versão SOMENTE FILMES para Nuvio.
 * CommonJS-friendly (mas escrito com async/await; ver nota de build no final).
 */

const DEBUG = false;
const log = (...args) => { if (DEBUG) console.log('[animezey]', ...args); };

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const MAX_RESULTS = 5;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMDB_API_KEY = 'COLE_SUA_CHAVE_TMDB_AQUI';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// ---------------------------------------------------------------------------
// Utils
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
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return '4K';
  if (n.includes('1080p') || n.includes('fullhd') || n.includes('full hd')) return '1080p';
  if (n.includes('720p')) return '720p';
  if (['hdtv', 'webdl', 'web-dl', 'webrip', 'hdrip', 'bluray', 'bdrip'].some(t => n.includes(t))) return 'HD';
  if (['dvdrip', 'sd', '480p', 'tvrip'].some(t => n.includes(t))) return 'SD';
  return 'HD';
}

function formatSize(sizeBytes) {
  try {
    const b = Number(sizeBytes);
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(2)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(2)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  } catch {
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
// HTTP
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function withRetry(fn, maxRetries = MAX_RETRIES, delayMs = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRetryable = e.name === 'AbortError' || e.name === 'TypeError';
      if (attempt === maxRetries - 1 || !isRetryable) throw e;
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

async function postToAnimezey(url, payload) {
  try {
    return await withRetry(async () => {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'accept-language': 'pt-BR,pt;q=0.9',
          'content-type': 'application/json',
          Referer: url,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
  } catch (e) {
    log(`Erro POST ${url}:`, e.message);
    return null;
  }
}

async function fetchTmdbMovie(tmdbId) {
  const url = `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=pt-BR`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Scraper (só filmes)
// ---------------------------------------------------------------------------

class AnimeZeyMovieScraper {
  constructor(providerUrl, itemData) {
    this.providerUrl = providerUrl;
    this.title = (itemData.title || '').trim();
    this.originalTitle = (itemData.original_title || '').trim();
    this.year = itemData.year || null;
    this._setupDomains();
    log(`🎯 Busca filme: '${this.title}' (${this.year})`);
  }

  _setupDomains() {
    let netloc = '1.animezey23112022.workers.dev';
    try {
      netloc = new URL(this.providerUrl).host || netloc;
    } catch {}
    this.baseDomain = netloc;
    this.downloadDomain = 'animezey16082023.animezey16082023.workers.dev';
  }

  async scrape() {
    try {
      return await this._searchMovies();
    } catch (e) {
      log('❌ Erro:', e.message);
      return [];
    }
  }

  async _searchMovies() {
    const seenIds = new Set();
    let movies = [];
    const queries = this._generateMovieQueries().slice(0, 8);
    const searchUrl = `https://${this.baseDomain}/1:search`;

    for (const query of queries) {
      const result = await postToAnimezey(searchUrl, { q: query });
      if (!result?.data?.files) continue;

      for (const item of result.data.files) {
        const itemId = item.id;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        if (this._isVideoFile(item) && this._isCorrectMovie(item.name || '')) {
          movies.push(item);
          if (movies.length >= MAX_RESULTS) return this._processResults(movies);
        }
      }
    }
    return movies.length ? this._processResults(movies) : [];
  }

  _generateMovieQueries() {
    const queries = [];
    const baseNames = this._getBaseNames().slice(0, 5);

    for (const name of baseNames) {
      let clean = removeAccents(name.replace(/['".:]/g, ''));
      clean = clean.replace(/\s*-\s*/g, ' ').trim();
      const dots = clean.replace(/ /g, '.');
      if (this.year) {
        queries.push(`${dots}.${this.year}`);
        queries.push(`${clean} ${this.year}`);
      }
      queries.push(dots);
      queries.push(clean);
    }

    if (this.originalTitle) {
      const rawOrig = this.originalTitle.replace(/['".\-]/g, '').trim();
      if (this.year) queries.push(`${rawOrig} ${this.year}`);
      queries.push(rawOrig);
    }

    return [...new Set(queries.filter(Boolean))];
  }

  _getBaseNames() {
    const names = [];
    for (const field of [this.title, this.originalTitle]) {
      if (!field) continue;
      const clean = field.trim();
      if (!names.includes(clean)) names.push(clean);
      if (clean.includes(':')) {
        const short = clean.split(':')[0].trim();
        if (!names.includes(short)) names.push(short);
      }
    }
    const final = [];
    for (const name of names) {
      final.push(name);
      if (name.includes("'")) final.push(name.replace(/'/g, ''));
      const lower = name.toLowerCase();
      for (const art of ['the ', 'a ', 'an ', 'o ', 'os ', 'as ']) {
        if (lower.startsWith(art)) {
          const rest = name.slice(art.length);
          if (!final.includes(rest)) final.push(rest);
          break;
        }
      }
    }
    return [...new Set(final.filter(Boolean))];
  }

  _normalizeFn(s) {
    let out = removeAccents((s || '').toLowerCase());
    out = out.replace(/[.\-_+,:]/g, ' ');
    out = out.replace(/[[\](){}]/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  _titleMatch(title, filename) {
    const titleN = this._normalizeFn(title);
    const fnN = this._normalizeFn(filename);
    if (!titleN) return false;

    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(titleN)}(?=[^a-z0-9]|$)`, 'g');

    let m;
    while ((m = pattern.exec(fnN)) !== null) {
      const after = fnN.slice(m.index + titleN.length).trim();
      const afterOk = !after || TITLE_END_RE.test(after) || /^[\-\u2013\u2014]?\s*\d/.test(after);
      if (!afterOk) continue;

      const before = fnN.slice(0, m.index).trim();
      if (!before) return true;

      const contentWords = before.split(/\s+/).filter(Boolean)
        .filter(w => !NOISE_WORD_RE.test(w) && !IGNORABLE_PREFIX_WORDS.has(w));
      if (!contentWords.length) return true;
    }
    return false;
  }

  _isCorrectMovie(filename) {
    const baseNames = this._getBaseNames();
    const fnLower = filename.toLowerCase();
    const fnNorm = normalizeForCompare(removeAccents(fnLower));

    for (const name of baseNames) {
      const nameAscii = removeAccents(name);
      const nameNorm = normalizeForCompare(nameAscii);
      const matched = this._titleMatch(nameAscii, fnLower) || this._titleMatch(nameNorm, fnNorm);
      if (matched) {
        return this.year ? fnLower.includes(String(this.year)) : true;
      }
    }
    return false;
  }

  _isVideoFile(item) {
    const name = (item.name || '').toLowerCase();
    const mime = item.mimeType || '';
    return mime.includes('video') || /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/.test(name);
  }

  async _processResults(items) {
    const results = [];
    const seenLinks = new Set();

    for (const item of items) {
      const url = await this._extractPlayerUrl(item);
      if (!url || seenLinks.has(url)) continue;
      seenLinks.add(url);
      results.push(this._createResultItem(item, url));
    }

    const order = { '4K': 0, '2160p': 0, '1080p': 1, '720p': 2, HD: 3, SD: 4 };
    results.sort((a, b) => (order[a.quality] ?? 99) - (order[b.quality] ?? 99));
    return results;
  }

  async _extractPlayerUrl(item) {
    try {
      const linkPart = item.link || '';
      if (!linkPart) return null;

      if (linkPart.includes('/download.aspx')) {
        return this._buildDownloadLink(linkPart);
      }

      let viewUrl = `https://${this.baseDomain}${linkPart}`;
      if (!viewUrl.includes('a=view')) {
        viewUrl += viewUrl.includes('?') ? '&a=view' : '?a=view';
      }

      const res = await fetchWithTimeout(viewUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          Referer: `https://${this.baseDomain}/`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      const srcMatch = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (srcMatch) return srcMatch[1];

      return this._buildDownloadLink(linkPart);
    } catch (e) {
      log('❌ Erro ao extrair URL do player:', e.message);
      return this._buildDownloadLink(item.link);
    }
  }

  _buildDownloadLink(linkPart) {
    if (!linkPart || !linkPart.startsWith('/')) return null;
    try {
      const [pathPart, queryString] = linkPart.split('?');
      const params = new URLSearchParams(queryString || '');
      const fileId = params.get('file');
      if (!fileId) return null;

      const outParams = new URLSearchParams({ file: fileId });
      for (const key of ['expiry', 'mac']) {
        const val = params.get(key);
        if (val) outParams.set(key, val);
      }

      return `https://${this.downloadDomain}${pathPart}?${outParams.toString()}`;
    } catch (e) {
      log('⚠️ Erro construindo link fallback:', e.message);
      return null;
    }
  }

  _createResultItem(fileData, downloadUrl) {
    const fileName = fileData.name || '';
    const quality = guessQualityFromName(fileName) || 'HD';
    const fnLower = fileName.toLowerCase();

    let language;
    if (['dual', 'multi'].some(x => fnLower.includes(x))) language = 'DUAL';
    else if (['dublado', 'dub ', 'pt-br'].some(x => fnLower.includes(x))) language = 'PT-BR';
    else if (['legendado', 'leg', 'sub', 'eng'].some(x => fnLower.includes(x))) language = 'LEG';
    else language = 'PT-BR';

    return {
      url: downloadUrl,
      quality,
      type: 'Direto',
      title: fileName,
      release_title: fileName,
      label: `${fileName} [${quality}]`,
      size: formatSize(fileData.size || 0),
      peers: 'N/A',
      seeders: 'N/A',
      provider: 'AnimeZey',
      languages: language,
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function getStreams(tmdbId, mediaType, providerUrl = 'https://1.animezey23112022.workers.dev') {
  try {
    if (mediaType !== 'movie') return []; // provider só cobre filmes

    const details = await fetchTmdbMovie(tmdbId);
    const dateStr = details.release_date || '';
    const itemData = {
      title: details.title,
      original_title: details.original_title,
      year: dateStr ? parseInt(dateStr.slice(0, 4), 10) : null,
    };

    const scraper = new AnimeZeyMovieScraper(providerUrl, itemData);
    return await scraper.scrape();
  } catch (e) {
    log('[getStreams] ❌ Erro:', e.message);
    return [];
  }
}

export default { getStreams };
