const { getStreams } = require('./animezey-movies.js');

console.log('--- Teste filme ---');
getStreams('615457', 'movie', null, null).then(function(streams) {
  console.log(JSON.stringify(streams, null, 2));
}).then(function() {
  console.log('--- Teste série ---');
  return getStreams('1396', 'tv', 1, 1); // Breaking Bad S1E1
}).then(function(streams) {
  console.log(JSON.stringify(streams, null, 2));
}).catch(function(err) {
  console.error('❌ Erro:', err);
});
