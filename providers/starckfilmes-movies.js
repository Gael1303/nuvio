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
const MAX_RESULTS = 6;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMDB_API_KEY = '70533e9a93ad18166cb20a576dc62607';
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

// Estratégia robusta: em vez de tentar delimitar o bloco inteiro
// <span class="btn-down">...</span> (frágil — depende de contar </span>
// certinho, e quebra se um dos links tiver estrutura levemente diferente),
// busca cada link data-u diretamente e usa o texto ao redor dele (antes e
// depois) pra achar idioma/qualidade/tamanho. Isso captura TODOS os links
// que existirem, não importa quantos.
// Corta o HTML antes da primeira seção que tipicamente NÃO faz parte do
// conteúdo do próprio filme (relacionados, comentários, rodapé, sidebar).
// Sem isso, a busca de links vaza pra outras seções da página que também
// têm data-u, pegando magnets de OUTROS filmes.
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
    const before = html.slice(Math.max(0, m.index - 500), m.index);
    const after = html.slice(re.lastIndex, re.lastIndex + 200);
    links.push({ dataU: m[1], linkText: stripTags(m[2]), before: before, after: after });
  }
  return links;
}

function parseDataULink(link, qualidadeFallback, tamanhoFallback) {
  const magnet = unshuffleString(link.dataU);
  if (!magnet || magnet.indexOf('magnet:') === -1) return null;

  // Filtro anti-isca: alguns sites injetam um torrent promocional com o
  // nome do próprio site no arquivo (dn=), sem relação com o filme. Se o
  // nome decodificado bater com o domínio do site, descarta.
  const dnMatch = magnet.match(/[?&]dn=([^&]+)/i);
  if (dnMatch) {
    let dn = dnMatch[1];
    try { dn = decodeURIComponent(dn.replace(/\+/g, ' ')); } catch (e) {}
    const dnLower = dn.toLowerCase();
    const siteKeywords = ['starckfilmes', 'starck filmes', 'starck-filmes'];
    if (siteKeywords.some(function (k) { return dnLower.includes(k); })) {
      log('Descartando torrent-isca com nome do site: ' + dn);
      return null;
    }
  }

  // Idioma: procura de trás pra frente no texto anterior ao link (o mais
  // próximo é o mais provável de pertencer a esse link específico).
  let idioma = 'PT-BR';
  const spansAntes = link.before.match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
  for (let i = spansAntes.length - 1; i >= 0; i--) {
    const txt = stripTags(spansAntes[i]).toLowerCase();
    if (txt.includes('dual') || txt.includes('multi') || txt.includes('dublado') || txt.includes('legendado')) {
      idioma = idiomaDoTexto(txt);
      break;
    }
  }

  // Qualidade/tamanho: procura no texto do próprio link, depois no que
  // vem antes/depois dele.
  let qualidade = qualidadeFallback;
  let tamanho = tamanhoFallback;
  const janela = link.linkText + ' ' + link.before.slice(-200) + ' ' + link.after;
  const mQ = janela.match(/(4K|2160p|1080p|720p|480p)/i);
  if (mQ) qualidade = mQ[1];
  const mS = janela.match(/\(([^)]+(?:GB|MB))\)/i);
  if (mS) tamanho = mS[1];

  return { url: magnet, idioma: idioma, qualidade: qualidade, tamanho: tamanho };
}

// Div "epsodios" (Caso A) — melhor esforço, assume que não há outra <div>
// aninhada antes do fechamento real.
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

function getPBlocksWithStrong(block) {
  const paragraphs = block.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  return paragraphs.filter(function (p) { return /<strong[^>]*>/i.test(p); });
}

function getStrongText(pBlock) {
  const m = pBlock.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  return m ? stripTags(m[1]) : '';
}

function getDataULinks(pBlock) {
  const links = [];
  const re = /<a[^>]+data-u=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(pBlock)) !== null) {
    links.push({ dataU: m[1], text: stripTags(m[2]) });
  }
  return links;
}

function temporadaOk(tituloPagina, seasonNum) {
  const re = new RegExp('(' + seasonNum + '[aª\\u00ba\\u00b0]?\\s*temporada|temporada\\s*' + seasonNum + ')', 'i');
  return re.test(tituloPagina);
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
      const contentStart = html.search(/<h[12][^>]*class=["'][^"']*post-title/i);
      const searchArea = contentStart !== -1 ? html.slice(contentStart) : html;
      const areaConteudo = cortarAntesDeSecoesIrrelevantes(searchArea);
      const links = getDataULinksWithContext(areaConteudo);

      links.forEach(function (link) {
        const parsed = parseDataULink(link, qualidade, tamanho);
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

  const cookieState = { cookie: '' };
  const sources = [];

  function processCard(card) {
    return fetchPagina(card.url, cookieState).then(function (html) {
      if (!html) return;

      const tituloPaginaLower = getTituloLimpo(html).toLowerCase();

      // CASO A: episódios separados
      const epDiv = getEpisodiosDiv(html);
      if (epDiv) {
        if (!temporadaOk(tituloPaginaLower, sNum)) return;

        const idiomaEp = idiomaDoTexto(getH3Text(epDiv));
        const qualidade = getQualidade(html);
        const tamanho = getTamanho(html);
        const tituloLimpo = getTituloLimpo(html) || titulo;

        if (!tituloCompativel(tituloLimpo, titulo)) return;

        const paragrafos = getPBlocksWithStrong(epDiv);
        for (let i = 0; i < paragrafos.length; i++) {
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

          const links = getDataULinks(paragrafos[i]);
          links.forEach(function (link) {
            const magnet = unshuffleString(link.dataU);
            if (!magnet || magnet.indexOf('magnet:') === -1) return;
            let qEp = qualidade;
            const mQ = link.text.match(/(4K|2160p|1080p|720p|480p)/i);
            if (mQ) qEp = mQ[1];
            sources.push({
              url: magnet,
              title: tituloLimpo + ' S' + sPad + 'E' + ePad,
              quality: (qEp || 'HD').toLowerCase(),
              size: tamanho,
              languages: idiomaEp,
            });
          });
          break; // já achou o parágrafo do episódio certo
        }
        return;
      }

      // CASO B: temporada inteira em bloco btn-down
      if (!temporadaOk(tituloPaginaLower, sNum)) return;

      const tituloLimpo = getTituloLimpo(html) || titulo;
      const qualidade = getQualidade(html);
      const tamanho = getTamanho(html);
      const contentStart = html.search(/<h[12][^>]*class=["'][^"']*post-title/i);
      const searchArea = contentStart !== -1 ? html.slice(contentStart) : html;
      const areaConteudo = cortarAntesDeSecoesIrrelevantes(searchArea);
      const links = getDataULinksWithContext(areaConteudo);

      links.forEach(function (link) {
        const parsed = parseDataULink(link, qualidade, tamanho);
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
    log('buscarSerie: ' + sources.length + ' fonte(s) encontrada(s)');
    return sources;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function fetchTmdbDetails(tmdbId, isMovie) {
  const path = isMovie ? '/movie/' + tmdbId : '/tv/' + tmdbId;
  const url = TMDB_BASE + path + '?api_key=' + TMDB_API_KEY + '&language=pt-BR';
  return fetchPlain(url).then(function (res) {
    if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
    return res.json();
  });
}

function mapToStreamObjects(sources, extraTitleSuffix) {
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
