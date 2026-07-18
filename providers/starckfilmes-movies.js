/**
 * StarckFilmes scraper — SOMENTE FILMES, sem a espera de 5.5s do gate de
 * verificação (sandbox não tem setTimeout). Extração via regex, já que não
 * há parser de DOM disponível — mais frágil que o AnimeZey (que era JSON puro).
 */

const DEBUG = true;
const log = function () {
  if (DEBUG) console.log.apply(console, ['[starck]'].concat(Array.prototype.slice.call(arguments)));
};

const BASE_URL = 'https://starckfilmes-v22.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMDB_API_KEY = 'COLE_SUA_CHAVE_TMDB_AQUI';
const TMDB_BASE = 'https://api.themoviedb.org/3';

function fetchPlain(url, options) {
  return fetch(url, options || {});
}

// ---------------------------------------------------------------------------
// Sessão simples (cookie manual) + bypass do gate — SEM espera
// ---------------------------------------------------------------------------

function starckGet(url, cookieState) {
  const headers = { 'User-Agent': USER_AGENT };
  if (cookieState.cookie) headers.Cookie = cookieState.cookie;

  return fetchPlain(url, { headers: headers }).then(function (res) {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookieState.cookie = setCookie.split(';')[0];
    return res.text().then(function (html) {
      return { html: html, ok: res.ok };
    });
  });
}

function isVerificationPage(html) {
  return html.includes('id="verifyBox"') ||
    html.includes('Verificação de Segurança') ||
    html.includes('Comunicado Importante');
}

function resolveVerification(url, cookieState) {
  // Sem setTimeout — dispara o POST na hora, sem os 5.5s que o site espera.
  // Pode falhar por causa disso; é a limitação conhecida dessa versão.
  const postUrl = BASE_URL + '/current-address';
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (cookieState.cookie) headers.Cookie = cookieState.cookie;

  return fetchPlain(postUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ timeMonit: '14542588' }),
  }).then(function (res) {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookieState.cookie = setCookie.split(';')[0];
    log('POST verificação status:', res.status);
    return starckGet(url, cookieState);
  }).catch(function (e) {
    log('Erro no POST de verificação:', e.message);
    return null;
  });
}

function starckGetWithBypass(url, cookieState, maxAttempts) {
  maxAttempts = maxAttempts || 2;
  return starckGet(url, cookieState).then(function (result) {
    function tryResolve(res, attempt) {
      if (!res || !isVerificationPage(res.html)) return res;
      if (attempt >= maxAttempts) return res; // devolve mesmo sendo gate — quem chama decide
      return resolveVerification(url, cookieState).then(function (nova) {
        return tryResolve(nova, attempt + 1);
      });
    }
    return tryResolve(result, 0);
  }).catch(function (e) {
    log('Erro em starckGetWithBypass:', e.message);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Decodificador do magnet embaralhado (idêntico ao Python)
// ---------------------------------------------------------------------------

function unshuffleString(shuffled) {
  try {
    const length = shuffled.length;
    const original = new Array(length).fill('');
    const used = new Array(length).fill(false);
    const step = 3;
    let index = 0;
    for (let i = 0; i < length; i++) {
      while (used[index]) index = (index + 1) % length;
      used[index] = true;
      original[i] = shuffled[index];
      index = (index + step) % length;
    }
    return original.join('');
  } catch (e) {
    log('unshuffle erro:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalização / matching de título
// ---------------------------------------------------------------------------

function removeAccents(text) {
  return (text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarTitulo(texto) {
  let s = removeAccents(texto || '').toLowerCase();
  s = s.replace(/['\,.\-_:]/g, ' ');
  s = s.replace(/\b(the|a|an|o|os|as|de|do|da|um|uma)\b/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tituloCompativel(tituloPagina, tituloBusca) {
  const normPagina = normalizarTitulo(tituloPagina);
  const normBusca = normalizarTitulo(tituloBusca);
  if (!normBusca) return true;

  const pattern = new RegExp('^' + escapeRegExp(normBusca) + '(\\s|$)');
  if (pattern.test(normPagina)) return true;

  const tokensBusca = normBusca.split(' ').filter(Boolean);
  const tokensPagina = normPagina.split(' ').filter(Boolean);
  if (!tokensBusca.length) return true;

  const matches = tokensBusca.filter(function (t) { return tokensPagina.indexOf(t) !== -1; }).length;
  const ratio = matches / tokensBusca.length;
  const threshold = tokensBusca.length <= 3 ? 1.0 : 0.9;
  if (ratio < threshold) return false;

  const idx = normPagina.indexOf(normBusca);
  if (idx > 0) {
    const stopWords = { the: 1, a: 1, an: 1, o: 1, os: 1, as: 1, de: 1, do: 1, da: 1, in: 1, of: 1, and: 1, em: 1, no: 1, na: 1, nos: 1, nas: 1, e: 1 };
    const prefixWords = normPagina.slice(0, idx).split(' ').filter(Boolean).filter(function (w) { return !stopWords[w]; });
    if (prefixWords.length) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Extração via regex (substitui BeautifulSoup)
// ---------------------------------------------------------------------------

function getTituloLimpo(html) {
  let m = html.match(/<h2[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  if (m) return stripTags(m[1]).trim();
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return stripTags(m[1]).replace(/\s*Torrent.*$/i, '').trim();
  return '';
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function getQualidade(html) {
  const m = html.match(/<span[^>]*class=["'][^"']*sl-quality[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!m) return 'HD';
  const raw = stripTags(m[1]).toUpperCase();
  const map = { FHD: '1080p', UHD: '4K', HD: '720p', SD: '480p' };
  return map[raw] || stripTags(m[1]);
}

function getDescField(html, labelSubstring) {
  const descMatch = html.match(/<div[^>]*class=["'][^"']*post-description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!descMatch) return '';
  const paragraphs = descMatch[1].match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (let i = 0; i < paragraphs.length; i++) {
    const spans = paragraphs[i].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
    if (spans.length >= 2) {
      const first = stripTags(spans[0]).toLowerCase();
      if (first.includes(labelSubstring)) {
        return stripTags(spans[1]);
      }
    }
  }
  return '';
}

function getAno(html) { return getDescField(html, 'lançamento') || getDescField(html, 'lancamento'); }
function getTamanho(html) { return getDescField(html, 'tamanho') || 'N/A'; }

function anoOk(html, anoEsperado) {
  if (!anoEsperado) return true;
  const anoPagina = getAno(html);
  const p = parseInt(anoPagina, 10);
  const e = parseInt(anoEsperado, 10);
  if (!Number.isFinite(p) || !Number.isFinite(e)) return true;
  return Math.abs(p - e) <= 1;
}

function idiomaDoTexto(texto) {
  const t = (texto || '').toLowerCase();
  if (t.includes('dual')) return 'DUAL';
  if (t.includes('dublado')) return 'DUBLADO';
  if (t.includes('legendado')) return 'LEGENDADO';
  return 'PT-BR';
}

// Extrai os blocos <span class="btn-down">...</span> — melhor esforço via
// regex não-guloso; assume que não há aninhamento de OUTRO btn-down dentro.
function getBtnDownBlocks(html) {
  const blocks = [];
  const re = /<span[^>]*class=["'][^"']*btn-down[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<\/span>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[0]);
  }
  return blocks;
}

function parseBtnDown(block, qualidadeFallback, tamanhoFallback) {
  const dataUMatch = block.match(/<a[^>]+data-u=["']([^"']+)["']/i);
  if (!dataUMatch) return null;
  const magnet = unshuffleString(dataUMatch[1]);
  if (!magnet || magnet.indexOf('magnet:') === -1) return null;

  // Idioma: primeiro <span> dentro de <span class="text">
  let idioma = 'PT-BR';
  const textSpanMatch = block.match(/<span[^>]*class=["'][^"']*\btext\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (textSpanMatch) {
    const innerSpans = textSpanMatch[1].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
    if (innerSpans.length) idioma = idiomaDoTexto(stripTags(innerSpans[0]));
  }

  let qualidade = qualidadeFallback;
  let tamanho = tamanhoFallback;
  if (textSpanMatch) {
    const innerSpans = textSpanMatch[1].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
    if (innerSpans.length >= 3) {
      const textoRes = stripTags(innerSpans[2]);
      const mQ = textoRes.match(/(4K|2160p|1080p|720p|480p)/i);
      if (mQ) qualidade = mQ[1];
      const mS = textoRes.match(/\(([^)]+(?:GB|MB))\)/i);
      if (mS) tamanho = mS[1];
    }
  }

  return { url: magnet, idioma: idioma, qualidade: qualidade, tamanho: tamanho };
}

// ---------------------------------------------------------------------------
// Busca no site
// ---------------------------------------------------------------------------

function executarBusca(query, cookieState) {
  const searchUrl = BASE_URL + '/?s=' + encodeURIComponent(query);
  return starckGetWithBypass(searchUrl, cookieState).then(function (result) {
    if (!result) return [];
    if (isVerificationPage(result.html)) {
      log('Ainda no gate de verificação após tentativa sem espera — provável falha.');
      return [];
    }
    const cards = [];
    const re = /<a[^>]+href=["']([^"']*\/catalog\/[^"']*)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(result.html)) !== null) {
      cards.push({ url: m[1], titulo: stripTags(m[2]) });
    }
    return cards;
  });
}

function buscarPaginas(query, tituloBusca, maxResults, cookieState) {
  return executarBusca(query, cookieState).then(function (cards) {
    const itens = [];
    for (let i = 0; i < cards.length && itens.length < maxResults; i++) {
      const card = cards[i];
      if (!card.url || !card.titulo) continue;
      if (tituloBusca) {
        const normCard = normalizarTitulo(card.titulo);
        const normBusca = normalizarTitulo(tituloBusca);
        const tokensBusca = normBusca.split(' ').filter(Boolean);
        const tokensCard = normCard.split(' ').filter(Boolean);
        if (tokensBusca.length) {
          const matches = tokensBusca.filter(function (t) { return tokensCard.indexOf(t) !== -1; }).length;
          if (matches / tokensBusca.length < 1.0) continue;
        }
      }
      itens.push(card);
    }
    return itens;
  });
}

function fetchPagina(url, cookieState) {
  return starckGetWithBypass(url, cookieState).then(function (result) {
    if (!result || isVerificationPage(result.html)) return null;
    return result.html;
  });
}

// ---------------------------------------------------------------------------
// Busca de filme
// ---------------------------------------------------------------------------

function buscarFilme(itemData) {
  const titulo = itemData.title || '';
  const tituloOriginal = itemData.original_title || '';
  const ano = itemData.year || '';

  if (!titulo) {
    log('buscarFilme: título vazio, abortando');
    return Promise.resolve([]);
  }

  const queries = [titulo];
  if (tituloOriginal && tituloOriginal.toLowerCase() !== titulo.toLowerCase()) {
    queries.push(tituloOriginal);
  }

  const cookieState = { cookie: '' };
  const sources = [];

  function processCard(card) {
    return fetchPagina(card.url, cookieState).then(function (html) {
      if (!html) return;
      if (!anoOk(html, ano)) return;

      const tituloLimpo = getTituloLimpo(html) || titulo;
      if (!tituloCompativel(tituloLimpo, titulo)) {
        log('Título incompatível: "' + tituloLimpo + '" vs "' + titulo + '"');
        return;
      }

      const qualidade = getQualidade(html);
      const tamanho = getTamanho(html);
      const blocks = getBtnDownBlocks(html);

      blocks.forEach(function (block) {
        const parsed = parseBtnDown(block, qualidade, tamanho);
        if (!parsed) return;
        sources.push({
          url: parsed.url,
          title: tituloLimpo,
          quality: (parsed.qualidade || 'HD').toLowerCase(),
          size: parsed.tamanho,
          languages: parsed.idioma,
        });
      });
    });
  }

  function processQuery(query) {
    if (sources.length) return Promise.resolve();
    return buscarPaginas(query, titulo, 5, cookieState).then(function (paginas) {
      return paginas.reduce(function (p, card) {
        return p.then(function () {
          if (sources.length) return Promise.resolve();
          return processCard(card);
        });
      }, Promise.resolve());
    });
  }

  return queries.reduce(function (p, q) {
    return p.then(function () { return processQuery(q); });
  }, Promise.resolve()).then(function () {
    log('buscarFilme: ' + sources.length + ' fonte(s) encontrada(s)');
    return sources;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function fetchTmdbMovie(tmdbId) {
  const url = TMDB_BASE + '/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=pt-BR';
  return fetchPlain(url).then(function (res) {
    if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
    return res.json();
  });
}

function getStreams(tmdbId, mediaType, season, episode, providerUrl) {
  function debugError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    log('[getStreams] ❌ Erro:', msg);
    return [{
      name: 'StarckFilmes [ERRO]',
      title: 'DEBUG: ' + msg,
      url: 'https://example.com/erro-debug',
      quality: '0p',
      group: 'DEBUG',
      provider: 'StarckFilmes',
      headers: {},
    }];
  }

  try {
    log('[getStreams] tmdbId=' + tmdbId + ' mediaType=' + mediaType);

    if (mediaType !== 'movie') {
      log('[getStreams] só filmes por enquanto, retornando vazio');
      return Promise.resolve([]);
    }

    return fetchTmdbMovie(tmdbId).then(function (details) {
      const dateStr = details.release_date || '';
      const itemData = {
        title: details.title,
        original_title: details.original_title,
        year: dateStr ? parseInt(dateStr.slice(0, 4), 10) : null,
      };
      log('[getStreams] TMDB OK: title="' + itemData.title + '" year=' + itemData.year);

      return buscarFilme(itemData).then(function (sources) {
        return sources.map(function (s) {
          return {
            name: 'StarckFilmes ' + (s.quality === '4k' ? '4K' : s.quality),
            title: '🎬 ' + s.title + '\n📦 StarckFilmes\n🌎 ' + s.languages + (s.size ? ('\n💾 ' + s.size) : ''),
            url: s.url,
            quality: s.quality,
            group: s.languages,
            provider: 'StarckFilmes',
            headers: {},
          };
        });
      });
    }).catch(debugError);
  } catch (e) {
    return Promise.resolve(debugError(e));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
