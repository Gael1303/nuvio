// Teste rápido do provider. Roda com: node test.js
// Exemplo usa o tmdbId do filme "Vingadores: Ultimato" (299534).
import { getStreams } from './animezey-movies.js';

const TMDB_ID = process.argv[2] || '299534';

getStreams(TMDB_ID, 'movie')
  .then((streams) => {
    console.log(`\n✅ ${streams.length} resultado(s) encontrado(s):\n`);
    console.log(JSON.stringify(streams, null, 2));
  })
  .catch((err) => {
    console.error('❌ Erro no teste:', err);
    process.exit(1);
  });
