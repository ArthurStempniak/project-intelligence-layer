/**
 * Demonstração da fundação: índice, grafo e busca.
 *
 * A CLI ainda não existe (itens 1.4–1.13 do ROADMAP). Este script exercita
 * diretamente a camada que já está pronta, com um projeto fictício em memória,
 * para que o comportamento seja observável antes de haver `pil scan`.
 *
 * Escrito em .mjs puro de propósito: roda sobre `dist/` depois do build, sem
 * precisar de tsx ou de qualquer runner adicional.
 *
 *   npm run demo
 */

import { SqliteStorage, makeEntityId, toFtsQuery, confidenceForTier } from '../dist/index.js';

const log = (...args) => console.log(...args);
const title = (t) => log(`\n\x1b[1m${t}\x1b[0m\n${'─'.repeat(t.length)}`);

// --- projeto fictício ------------------------------------------------------
// controller → service → repository, mais um arquivo sem relação nenhuma
// com o fluxo, que serve para verificar se a busca o mantém de fora.

const file = (path) => ({
  path,
  language: 'typescript',
  sizeBytes: 400,
  lineCount: 40,
  contentHash: `hash-${path}`,
  parseState: 'OK',
  indexedAt: Date.now(),
  mtimeMs: Date.now(),
  tokenEstimate: 120,
});

const fn = (path, name, signature) => ({
  id: makeEntityId({ filePath: path, type: 'FUNCTION', qualifiedName: name }),
  type: 'FUNCTION',
  name,
  qualifiedName: name,
  language: 'typescript',
  filePath: path,
  startLine: 10,
  endLine: 30,
  startByte: 200,
  endByte: 800,
  signature,
  exported: true,
  fingerprint: `fp-${name}`,
  tokenEstimate: 95,
});

const calls = (from, to) => ({
  sourceId: from.id,
  targetId: to.id,
  targetHint: to.qualifiedName,
  type: 'CALLS',
  resolution: 'EXACT',
  confidence: confidenceForTier('EXACT'),
  filePath: from.filePath,
  line: 15,
});

const controller = fn(
  'src/commission/commissionController.ts',
  'handleCommissionRequest',
  'handleCommissionRequest(req: Request): Promise<Response>',
);
const service = fn(
  'src/commission/commissionService.ts',
  'calculateCommission',
  'calculateCommission(sales: Sale[], rate: number): number',
);
const repository = fn(
  'src/commission/commissionRepository.ts',
  'findSalesBySeller',
  'findSalesBySeller(sellerId: number): Promise<Sale[]>',
);
const report = fn(
  'src/reports/monthlyReport.ts',
  'buildMonthlyReport',
  'buildMonthlyReport(month: string): Report',
);
const banner = fn('src/home/banner.ts', 'renderHomeBanner', 'renderHomeBanner(): JSX.Element');

const storage = new SqliteStorage(':memory:');
await storage.migrate();

// A ordem importa: o alvo precisa existir para a aresta nascer EXACT.
await storage.replaceFileAnalysis(file(repository.filePath), [repository], []);
await storage.replaceFileAnalysis(file(service.filePath), [service], [calls(service, repository)]);
await storage.replaceFileAnalysis(file(controller.filePath), [controller], [
  calls(controller, service),
]);
await storage.replaceFileAnalysis(file(report.filePath), [report], [calls(report, service)]);
await storage.replaceFileAnalysis(file(banner.filePath), [banner], []);

title('1. Índice construído');
const stats = await storage.stats();
log(`arquivos:  ${stats.files}`);
log(`entidades: ${stats.entities}`);
log(`relações:  ${stats.relations} (${stats.unresolvedRelations} não resolvidas)`);
log(`tokens do projeto inteiro: ${stats.totalTokens}`);

// --- busca: linguagem natural contra identificador colado ------------------

title('2. Busca lexical — o que o FTS resolve e o que não resolve');

async function buscar(tarefa) {
  log(`\n  tarefa: "${tarefa}"`);
  const hits = await storage.searchLexical(toFtsQuery(tarefa), 10);
  if (hits.length === 0) {
    log('    \x1b[31mnenhum resultado\x1b[0m');
    return hits;
  }
  for (const hit of hits) {
    const entity = await storage.getEntity(hit.entityId);
    log(
      `    ${hit.rawScore.toFixed(2).padStart(6)}  ${entity.name.padEnd(24)}` +
        `\x1b[2m${entity.filePath}\x1b[0m`,
    );
  }
  return hits;
}

// Barreira de FORMA: palavras separadas contra identificador colado. Resolvida
// pela quebra de identificadores na indexação.
await buscar('fix the commission calculation');

// Barreira de IDIOMA: `comissao` e `commission` sao palavras distintas para o
// FTS. Nenhum stemmer aproxima as duas — isso e traducao, nao normalizacao.
await buscar('corrigir o cálculo de comissão dos vendedores');

log('\n  \x1b[2mA quebra de identificadores resolve forma, não idioma.\x1b[0m');
log('  \x1b[2mVer ARCHITECTURE.md seção 10 — é o que decide quando embeddings');
log('  deixam de ser opcionais neste projeto.\x1b[0m');

// --- impacto: travessia reversa --------------------------------------------

title('3. Impacto — quem quebra se calculateCommission mudar?');
const callers = await storage.neighbors({
  seedIds: [service.id],
  depth: 3,
  direction: 'IN',
});

for (const c of callers.filter((c) => c.hopDistance > 0)) {
  const entity = await storage.getEntity(c.entityId);
  const tipo = c.hopDistance === 1 ? 'direto  ' : 'indireto';
  log(
    `  ${tipo}  ${entity.name.padEnd(24)} ` +
      `\x1b[2mhops=${c.hopDistance} confiança=${c.pathConfidence.toFixed(2)}\x1b[0m`,
  );
}

// --- incremental: o que muda quando um arquivo é editado -------------------

title('4. Indexação incremental');
const noDisco = [
  { path: repository.filePath, contentHash: `hash-${repository.filePath}`, mtimeMs: 1, sizeBytes: 400 },
  { path: service.filePath, contentHash: 'CONTEUDO-EDITADO', mtimeMs: 1, sizeBytes: 400 },
  { path: controller.filePath, contentHash: `hash-${controller.filePath}`, mtimeMs: 1, sizeBytes: 400 },
  { path: report.filePath, contentHash: `hash-${report.filePath}`, mtimeMs: 1, sizeBytes: 400 },
  { path: 'src/commission/commissionValidation.ts', contentHash: 'novo', mtimeMs: 1, sizeBytes: 400 },
];

const changes = await storage.computeChangeSet(noDisco);
log(`  adicionados: ${changes.added.length}  ${changes.added.join(', ')}`);
log(`  modificados: ${changes.modified.length}  ${changes.modified.join(', ')}`);
log(`  removidos:   ${changes.deleted.length}  ${changes.deleted.join(', ')}`);
log(`  inalterados: ${changes.unchangedCount} (não serão reparseados)`);

// --- invariante: rebaixar em vez de apagar ---------------------------------

title('5. Invariante — aresta sobrevive ao sumiço temporário do alvo');
await storage.replaceFileAnalysis(file(service.filePath), [], []);
let [aresta] = await storage.relationsFrom(controller.id);
log(`  alvo removido  → resolution=${aresta.resolution}  pista="${aresta.targetHint}"`);

await storage.replaceFileAnalysis(file(service.filePath), [service], [calls(service, repository)]);
[aresta] = await storage.relationsFrom(controller.id);
log(`  alvo de volta  → resolution=${aresta.resolution}  confiança=${aresta.confidence}`);
log('\n  \x1b[2mA aresta nunca foi apagada: a pista sobreviveu e permitiu religar.\x1b[0m');

await storage.close();
log('');
