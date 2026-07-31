// Testa série no StarckFilmes. Roda com: node test-serie-starck.js <tmdbId> <season> <episode>
// Exemplo: node test-serie-starck.js 1396 1 1  (Breaking Bad S1E1)
const { getStreams } = require('./providers/starckfilmes-movies.js');

const tmdbId = process.argv[2] || '1396';
const season = parseInt(process.argv[3] || '1', 10);
const episode = parseInt(process.argv[4] || '1', 10);

console.log('Testando: tmdbId=' + tmdbId + ' season=' + season + ' episode=' + episode);

getStreams(tmdbId, 'tv', season, episode)
  .then((streams) => {
    console.log('\n✅ ' + streams.length + ' resultado(s) encontrado(s):\n');
    console.log(JSON.stringify(streams, null, 2));
  })
  .catch((err) => {
    console.error('❌ Erro fatal no teste:', err);
    process.exit(1);
  });
