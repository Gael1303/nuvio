/**
 * StarckFilmes scraper — SOMENTE FILMES, sem a espera de 5.5s do gate de
 * verificação (sandbox não tem setTimeout). Extração via regex, já que não
 * há parser de DOM disponível — mais frágil que o AnimeZey (que era JSON puro).
 */

const DEBUG = true;
const log = function () {
  if (DEBUG) console.log.apply(console, ['[starck]'].concat(Array.prototype.slice.call(arguments)));
};

const BASE_URL = 'https://starckfilmes-v29.com';
const MAX_RESULTS = 4;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMDB_API_KEY = 'fbd7330e6872ea2d2ef87adc1ca6102a';
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
      if (attempt >= maxAttempts) return res;
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
// Decodificador do magnet embaralhado
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
// Links novos: https://filmedl.com/?xid=... (xid = base64 do magnet, embaralhado
// com o mesmo unshuffle de passo 3). Decodificado localmente, sem pedir nada
// ao filmedl.com.
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToUtf8(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+\/]/g, '');
  const bytes = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64_CHARS.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xFF);
      buf = buf & ((1 << bits) - 1);
    }
  }
  let out = '';
  let j = 0;
  while (j < bytes.length) {
    const c = bytes[j++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xE0) {
      out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[j++] & 0x3F));
    } else if (c < 0xF0) {
      const c2 = bytes[j++];
      const c3 = bytes[j++];
      out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
    } else {
      const c2 = bytes[j++];
      const c3 = bytes[j++];
      const c4 = bytes[j++];
      const cp = (((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F)) - 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return out;
}

function decodeXid(xid) {
  try {
    const b64 = unshuffleString(xid);
    if (!b64) return null;
    const magnet = base64ToUtf8(b64);
    return magnet.indexOf('magnet:') === 0 ? magnet : null;
  } catch (e) {
    log('decodeXid erro:', e.message);
    return null;
  }
}

function formatSize(sizeBytes) {
  const b = Number(sizeBytes);
  if (!Number.isFinite(b) || b <= 0) return 'N/A';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function parseMagnetInfo(magnet) {
  let dn = '';
  const dnM = magnet.match(/[?&]dn=([^&]+)/i);
  if (dnM) {
    try { dn = decodeURIComponent(dnM[1].replace(/\+/g, ' ')); } catch (e) { dn = dnM[1]; }
  }
  const xlM = magnet.match(/[?&]xl=(\d+)/i);
  return { dn: dn, size: xlM ? formatSize(xlM[1]) : 'N/A' };
}

// Último ano de 4 dígitos no nome do torrent (o ano de lançamento costuma vir
// depois do título; evita confundir com títulos como "2001: Uma Odisseia").
function anoDoNomeTorrent(dn) {
  const all = String(dn || '').match(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g);
  if (!all || !all.length) return null;
  const last = all[all.length - 1].match(/((?:19|20)\d{2})/);
  return last ? parseInt(last[1], 10) : null;
}

function criarFonteDoMagnet(magnet, titulo, qualidadePagina, tamanhoPagina, textoExtra) {
  const info = parseMagnetInfo(magnet);
  const contexto = info.dn + ' ' + (textoExtra || '');
  const mQ = contexto.match(/(2160p|4K|1080p|720p|480p)/i);
  const qualidade = mQ ? mQ[1] : (qualidadePagina || 'HD');
  return {
    url: magnet,
    title: titulo,
    quality: String(qualidade).toLowerCase(),
    size: info.size !== 'N/A' ? info.size : (tamanhoPagina || 'N/A'),
    languages: idiomaDoTexto(contexto),
  };
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
// Extração via regex
// ---------------------------------------------------------------------------

function getTituloLimpo(html) {
  let m = html.match(/<h2[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  if (m) return stripTags(m[1]).trim();
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return stripTags(m[1]).replace(/\s*Torrent.*$/i, '').trim();
  return '';
}

const HTML_ENTITIES = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  ordf: 'ª', ordm: 'º', ccedil: 'ç', Ccedil: 'Ç',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', Agrave: 'À', acirc: 'â', ecirc: 'ê', ocirc: 'ô',
  Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', atilde: 'ã', otilde: 'õ',
  Atilde: 'Ã', Otilde: 'Õ', uuml: 'ü', ntilde: 'ñ',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&([a-zA-Z]+);/g, function (all, name) {
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : all;
    })
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
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
  const mAno = String(anoPagina).match(/(?:19|20)\d{2}/);
  const p = mAno ? parseInt(mAno[0], 10) : NaN;
  const e = parseInt(anoEsperado, 10);
  log('anoOk: pagina="' + anoPagina + '" -> ' + p + ' | esperado=' + e);
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

function cortarAntesDeSecoesIrrelevantes(html) {
  const marcadores = [
    /<div[^>]*class=["'][^"']*relacionad[^"']*["']/i,
    /<div[^>]*class=["'][^"']*similar[^"']*["']/i,
    /<div[^>]*class=["'][^"']*related[^"']*["']/i,
    /<div[^>]*id=["']comments?["']/i,
    /<div[^>]*id=["']respond["']/i,
    /<div[^>]*class=["'][^"']*sidebar[^"']*["']/i,
    /<div[^>]*class=["'][^"']*widget[^"']*["']/i,
    /<footer[\s>]/i,
    /<div[^>]*class=["'][^"']*post-navigation[^"']*["']/i,
    /voc[eê]\s*(tamb[eé]m\s*)?pode\s*gostar/i,
    /assista\s*tamb[eé]m/i,
    /recomendados?\b/i,
    /mais\s*como\s*este/i,
  ];

  let cortIdx = html.length;
  marcadores.forEach(function (re) {
    const m = html.match(re);
    if (m && m.index < cortIdx) cortIdx = m.index;
  });

  return html.slice(0, cortIdx);
}

function getDataULinksWithContext(html) {
  const links = [];
  const re = /<a[^>]+data-u=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 200), m.index);
    const after = html.slice(re.lastIndex, re.lastIndex + 500);
    links.push({ dataU: m[1], linkText: stripTags(m[2]), before: before, after: after });
  }
  return links;
}

function getMagnetLinks(html) {
  const out = [];
  const seen = {};
  function push(magnet, text) {
    if (!magnet || seen[magnet]) return;
    seen[magnet] = true;
    out.push({ magnet: magnet, text: text || '' });
  }

  let m;
  const reX = /<a[^>]+href=["'][^"']*[?&]xid=([^"'&\s]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reX.exec(html)) !== null) {
    push(decodeXid(m[1]), stripTags(m[2]));
  }

  const reD = /<a[^>]+data-u=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reD.exec(html)) !== null) {
    const magnet = unshuffleString(m[1]);
    if (magnet && magnet.indexOf('magnet:') === 0) push(magnet, stripTags(m[2]));
  }
  return out;
}

function parseDataULink(link, qualidadeFallback, tamanhoFallback) {
  const magnet = unshuffleString(link.dataU);
  if (!magnet || magnet.indexOf('magnet:') === -1) return null;

  let idioma = 'PT-BR';
  let qualidade = qualidadeFallback;
  let tamanho = tamanhoFallback;

  const textSpanMatch = link.after.match(/<span[^>]*class=["'][^"']*\btext\b[^"']*["'][^>]*>([\s\S]*?<\/span>\s*<\/span>)/i);
  if (textSpanMatch) {
    const innerSpans = textSpanMatch[1].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
    if (innerSpans.length >= 1) {
      idioma = idiomaDoTexto(stripTags(innerSpans[0]));
    }
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

function getEpisodiosDiv(html) {
  const m = html.match(/<div[^>]*class=["'][^"']*\bepsodios\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (m) return m[1];
  const m2 = html.match(/<div[^>]*class=["'][^"']*\bepsodios\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return m2 ? m2[1] : null;
}

function getH3Text(block) {
  const m = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  return m ? stripTags(m[1]) : '';
}

function splitByH3Sections(html) {
  const parts = html.split(/(<h3[^>]*>[\s\S]*?<\/h3>)/i);
  const sections = [];
  let currentLabel = '';
  for (let i = 0; i < parts.length; i++) {
    if (/^<h3/i.test(parts[i])) {
      currentLabel = stripTags(parts[i]);
    } else if (parts[i] && parts[i].trim()) {
      sections.push({ label: currentLabel, content: parts[i] });
    }
  }
  return sections;
}

function getPBlocksWithStrong(block) {
  const paragraphs = block.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  return paragraphs.filter(function (p) { return /<strong[^>]*>/i.test(p); });
}

function getStrongText(pBlock) {
  const m = pBlock.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  return m ? stripTags(m[1]) : '';
}

function getDataULinks(pBlock) {
  return getMagnetLinks(pBlock);
}

function temporadaOk(tituloPagina, seasonNum) {
  const re = new RegExp('(' + seasonNum + '[aª\\u00ba\\u00b0]?\\s*temporada|temporada\\s*' + seasonNum + ')', 'i');
  return re.test(tituloPagina);
}

function absolutizarUrl(url) {
  if (!url) return url;
  if (url.charAt(0) === '/') return BASE_URL + url;
  return url;
}

function executarBusca(query, cookieState) {
  const searchUrl = BASE_URL + '/?s=' + encodeURIComponent(query);
  return starckGetWithBypass(searchUrl, cookieState).then(function (result) {
    if (!result) return [];
    if (isVerificationPage(result.html)) {
      log('Ainda no gate de verificação após tentativa sem espera — provável falha.');
      return [];
    }
    const cards = [];
    const seenUrls = {};
    function addCard(url, titulo) {
      const abs = absolutizarUrl(url);
      if (!abs || seenUrls[abs]) return;
      seenUrls[abs] = true;
      cards.push({ url: abs, titulo: stripTags(titulo) });
    }

    // Formato esperado: href antes do title
    const re = /<a[^>]+href=["']([^"']*\/catalog\/[^"']*)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(result.html)) !== null) {
      addCard(m[1], m[2]);
    }

    // Fallback: title antes do href
    if (!cards.length) {
      const re2 = /<a[^>]+title=["']([^"']*)["'][^>]*href=["']([^"']*\/catalog\/[^"']*)["'][^>]*>/gi;
      while ((m = re2.exec(result.html)) !== null) {
        addCard(m[2], m[1]);
      }
    }

    log('executarBusca: query="' + query + '" -> ' + cards.length + ' card(s) com /catalog/ encontrados (html ' + result.html.length + ' chars, status ok=' + result.ok + ')');
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
    log('buscarPaginas: query="' + query + '" -> ' + itens.length + ' pagina(s) candidata(s) apos filtro de titulo');
    return itens;
  });
}

function fetchPagina(url, cookieState) {
  return starckGetWithBypass(url, cookieState).then(function (result) {
    if (!result) { log('fetchPagina: sem resposta para ' + url); return null; }
    if (isVerificationPage(result.html)) { log('fetchPagina: caiu no gate de verificacao em ' + url); return null; }
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
  const magnetsVistos = {};

  function processCard(card) {
    if (/temporada|\bs\d{1,2}e\d{1,2}\b/i.test((card.titulo || '') + ' ' + (card.url || ''))) {
      log('processCard (filme): ignorado (parece serie): ' + card.url);
      return Promise.resolve();
    }
    return fetchPagina(card.url, cookieState).then(function (html) {
      if (!html) return;
      log('processCard (filme): ' + card.url + ' html=' + html.length + ' chars, data-u=' + (html.match(/data-u=/g) || []).length + ', post-title=' + (html.match(/post-title/g) || []).length);
      if (!anoOk(html, ano)) { log('processCard (filme): reprovado pelo ano'); return; }

      const tituloLimpo = getTituloLimpo(html) || titulo;
      if (!tituloCompativel(tituloLimpo, titulo)) {
        log('Título incompatível: "' + tituloLimpo + '" vs "' + titulo + '"');
        return;
      }

      const qualidade = getQualidade(html);
      const tamanho = getTamanho(html);
      const links = getMagnetLinks(html);
      log('processCard (filme): ' + links.length + ' link(s) de download em ' + card.url);

      links.forEach(function (link) {
        if (sources.length >= MAX_RESULTS) return;
        if (magnetsVistos[link.magnet]) return;
        const dnTorrent = parseMagnetInfo(link.magnet).dn;
        if (/\bs\d{1,2}e\d{1,2}\b/i.test(dnTorrent)) {
          log('ignorado (episodio de serie): ' + dnTorrent);
          return;
        }
        const anoTorrent = anoDoNomeTorrent(dnTorrent);
        const anoEsp = parseInt(ano, 10);
        if (anoTorrent && Number.isFinite(anoEsp) && Math.abs(anoTorrent - anoEsp) > 1) {
          log('ignorado por ano: torrent=' + anoTorrent + ' esperado=' + anoEsp + ' (' + tituloLimpo + ')');
          return;
        }
        magnetsVistos[link.magnet] = true;
        sources.push(criarFonteDoMagnet(link.magnet, tituloLimpo, qualidade, tamanho, link.text));
      });
    });
  }

  function processQuery(query) {
    if (sources.length >= MAX_RESULTS) return Promise.resolve();
    return buscarPaginas(query, titulo, 8, cookieState).then(function (paginas) {
      return paginas.reduce(function (p, card) {
        return p.then(function () {
          if (sources.length >= MAX_RESULTS) return Promise.resolve();
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
// Busca de série
// ---------------------------------------------------------------------------

function buscarSerie(itemData, season, episode) {
  const titulo = itemData.title || '';
  const tituloOriginal = itemData.original_title || '';

  if (!titulo || season == null || episode == null) {
    log('buscarSerie: parâmetros inválidos, abortando');
    return Promise.resolve([]);
  }

  const sNum = parseInt(season, 10);
  const eNum = parseInt(episode, 10);
  const sPad = String(sNum).padStart(2, '0');
  const ePad = String(eNum).padStart(2, '0');

  const queries = [titulo];
  if (tituloOriginal && tituloOriginal.toLowerCase() !== titulo.toLowerCase()) {
    queries.push(tituloOriginal);
  }
  log('buscarSerie: queries=' + JSON.stringify(queries) + ' sNum=' + sNum + ' eNum=' + eNum);

  const cookieState = { cookie: '' };
  const sources = [];
  const magnetsVistos = {};

  function processCard(card) {
    log('processCard (serie): abrindo ' + card.url);
    return fetchPagina(card.url, cookieState).then(function (html) {
      if (!html) { log('processCard (serie): html vazio/nulo'); return; }

      const tituloPaginaLower = getTituloLimpo(html).toLowerCase();
      log('processCard (serie): tituloPagina="' + tituloPaginaLower + '"');

      const epDiv = getEpisodiosDiv(html);
      log('processCard (serie): epDiv encontrado? ' + !!epDiv);

      if (epDiv) {
        const tOk = temporadaOk(tituloPaginaLower, sNum);
        log('processCard (serie) Caso A: temporadaOk(' + sNum + ')=' + tOk);
        if (!tOk) return;

        const tituloLimpo = getTituloLimpo(html) || titulo;
        const compat = tituloCompativel(tituloLimpo, titulo);
        log('processCard (serie) Caso A: tituloCompativel("' + tituloLimpo + '", "' + titulo + '")=' + compat);
        if (!compat) return;

        const secoes = splitByH3Sections(epDiv);
        log('processCard (serie) Caso A: ' + secoes.length + ' secao(oes) h3 encontrada(s)');
        const listaSecoes = secoes.length ? secoes : [{ label: '', content: epDiv }];

        listaSecoes.forEach(function (secao) {
          if (sources.length >= MAX_RESULTS) return;
          const idiomaSecao = idiomaDoTexto(secao.label);
          const paragrafos = getPBlocksWithStrong(secao.content);
          log('processCard (serie) Caso A: secao="' + secao.label + '" -> ' + paragrafos.length + ' paragrafo(s) com <strong>');

          for (let i = 0; i < paragrafos.length; i++) {
            if (sources.length >= MAX_RESULTS) break;
            const epText = getStrongText(paragrafos[i]).toLowerCase();
            let encontrado = false;

            if (new RegExp('epis[oó]dios?\\s+0?' + eNum + '\\b').test(epText)) {
              encontrado = true;
            }
            if (!encontrado) {
              const m = epText.match(/epis[oó]dios?\s+0?(\d+)\s+(?:e|ao)\s+0?(\d+)/);
              if (m && parseInt(m[1], 10) <= eNum && eNum <= parseInt(m[2], 10)) encontrado = true;
            }
            if (!encontrado) continue;

            log('processCard (serie) Caso A: paragrafo do episodio encontrado: "' + epText + '"');
            const links = getDataULinks(paragrafos[i]);
            links.forEach(function (link) {
              if (sources.length >= MAX_RESULTS) return;
              const magnet = link.magnet;
              if (!magnet) return;
              if (magnetsVistos[magnet]) return;
              magnetsVistos[magnet] = true;
              sources.push(criarFonteDoMagnet(magnet, tituloLimpo + ' S' + sPad + 'E' + ePad, 'HD', 'N/A', link.text + ' ' + secao.label));
            });
            break;
          }
        });
        return;
      }

      // CASO B
      const tOkB = temporadaOk(tituloPaginaLower, sNum);
      log('processCard (serie) Caso B: temporadaOk(' + sNum + ')=' + tOkB);
      if (!tOkB) return;

      const tituloLimpo = getTituloLimpo(html) || titulo;
      const qualidade = getQualidade(html);
      const tamanho = getTamanho(html);
      const links = getMagnetLinks(html);
      log('processCard (serie) Caso B: ' + links.length + ' link(s) de download encontrado(s)');

      links.forEach(function (link) {
        if (sources.length >= MAX_RESULTS) return;
        if (magnetsVistos[link.magnet]) return;
        magnetsVistos[link.magnet] = true;
        sources.push(criarFonteDoMagnet(link.magnet, tituloLimpo, qualidade, tamanho, link.text));
      });
    });
  }

  function processQuery(query) {
    if (sources.length >= MAX_RESULTS) return Promise.resolve();
    return buscarPaginas(query, titulo, 8, cookieState).then(function (paginas) {
      log('buscarSerie: query="' + query + '" -> ' + paginas.length + ' pagina(s) candidata(s)');
      return paginas.reduce(function (p, card) {
        return p.then(function () {
          if (sources.length >= MAX_RESULTS) return Promise.resolve();
          return processCard(card);
        });
      }, Promise.resolve());
    });
  }

  return queries.reduce(function (p, q) {
    return p.then(function () { return processQuery(q); });
  }, Promise.resolve()).then(function () {
    log('buscarSerie: ' + sources.length + ' fonte(s) encontrada(s)');
    return sources;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function resolveTmdbId(id, isMovie) {
  const idStr = String(id);
  if (idStr.indexOf('tt') !== 0) return Promise.resolve(idStr);

  const findUrl = TMDB_BASE + '/find/' + idStr + '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id';
  return fetchPlain(findUrl).then(function (res) {
    if (!res.ok) throw new Error('TMDB find HTTP ' + res.status);
    return res.json();
  }).then(function (data) {
    const results = isMovie ? data.movie_results : data.tv_results;
    if (results && results.length) return results[0].id;
    const alt = isMovie ? data.tv_results : data.movie_results;
    if (alt && alt.length) return alt[0].id;
    throw new Error('IMDb ID ' + idStr + ' não encontrado na TMDB');
  });
}

function fetchTmdbDetails(tmdbId, isMovie) {
  return resolveTmdbId(tmdbId, isMovie).then(function (realId) {
    const path = isMovie ? '/movie/' + realId : '/tv/' + realId;
    const url = TMDB_BASE + path + '?api_key=' + TMDB_API_KEY + '&language=pt-BR';
    return fetchPlain(url).then(function (res) {
      if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
      return res.json();
    });
  });
}

function mapToStreamObjects(sources) {
  return sources.map(function (s) {
    const sizeInfo = (s.size && s.size !== 'N/A') ? ('\n💾 ' + s.size) : '';
    return {
      name: 'StarckFilmes',
      title: '🎬 ' + s.title + '\n🌎 ' + s.languages + sizeInfo,
      url: s.url,
      quality: s.quality,
      group: s.languages,
      provider: 'StarckFilmes',
      headers: {},
    };
  });
}

function getStreams(tmdbId, mediaType, season, episode, providerUrl) {
  function debugError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    const ctx = 'id=' + tmdbId + ' type=' + mediaType + (season != null ? ' S' + season + 'E' + episode : '');
    log('[getStreams] ❌ Erro:', msg, ctx);
    return [{
      name: 'StarckFilmes [ERRO] ' + msg.slice(0, 60) + ' (' + ctx + ')',
      title: 'DEBUG: ' + msg,
      url: 'https://example.com/erro-debug',
      quality: '0p',
      group: 'DEBUG',
      provider: 'StarckFilmes',
      headers: {},
    }];
  }

  try {
    log('[getStreams] tmdbId=' + tmdbId + ' mediaType=' + mediaType + ' season=' + season + ' episode=' + episode);

    const isMovie = mediaType === 'movie';
    const isTv = mediaType === 'tv' || mediaType === 'series' || mediaType === 'tvshow';
    if (!isMovie && !isTv) {
      log('[getStreams] mediaType não suportado: ' + mediaType);
      return Promise.resolve([]);
    }

    return fetchTmdbDetails(tmdbId, isMovie).then(function (details) {
      const title = isMovie ? details.title : details.name;
      const originalTitle = isMovie ? details.original_title : details.original_name;
      const dateStr = details.release_date || details.first_air_date || '';
      const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;

      log('[getStreams] TMDB OK: title="' + title + '" year=' + year);

      const itemData = { title: title, original_title: originalTitle, year: year };
      const p = isMovie ? buscarFilme(itemData) : buscarSerie(itemData, season, episode);

      return p.then(function (sources) {
        return mapToStreamObjects(sources);
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
