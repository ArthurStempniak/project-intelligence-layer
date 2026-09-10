/**
 * Léxico de domínio: ponte entre o idioma da tarefa e o do código.
 *
 * Terceira das três saídas da ARCHITECTURE.md §10, e a única que resolve o caso
 * em que não há cognato: `subscription`/`assinatura`, `billing`/`cobrança`,
 * `order`/`pedido` não compartilham raiz, então nem prefixo nem stemmer os
 * aproximam. É tradução, e tradução precisa de uma lista.
 *
 * ---
 *
 * **Resultado medido: a expansão ampla piora o contexto.**
 *
 * A primeira versão aplicava {@link SUGGESTED_GROUPS} por padrão. O benchmark
 * reprovou: recall caiu de 57% para 55% e a precisão despencou de 22% para 7%.
 * A causa é direta — expandir cada termo para 3–5 sinônimos multiplica os
 * candidatos, e o ranking não tem como distinguir qual sinônimo era o
 * pretendido. Um caso passou de 2 para 29 arquivos selecionados, todos errados.
 *
 * Por isso o léxico é **vazio por padrão**. O mecanismo continua, porque um
 * dicionário *curado pelo dono do projeto* é preciso onde uma lista genérica é
 * ruído: quem sabe que naquele código `ocorrencia` é o que a tarefa chama de
 * `ticket` pode dizer isso em `.pil/config.json`, e ganha o casamento sem pagar
 * a diluição de outros 40 grupos irrelevantes.
 *
 * {@link SUGGESTED_GROUPS} fica como ponto de partida para copiar e recortar —
 * não como default.
 */
/**
 * Ponto de partida para o dicionário de um projeto PT/EN.
 *
 * Cada grupo é uma lista de termos equivalentes, e a expansão é bidirecional
 * por construção: `assinatura` acha `subscription` e vice-versa, sem precisar
 * de duas entradas.
 *
 * **Não é aplicado por padrão** (ver o cabeçalho): serve para o usuário copiar
 * os poucos grupos que valem para o seu domínio em `context.dictionary`.
 */
export const SUGGESTED_GROUPS: ReadonlyArray<readonly string[]> = [
  ['user', 'usuario', 'usuarios', 'users'],
  ['client', 'cliente', 'clientes', 'clients', 'customer', 'customers'],
  ['payment', 'pagamento', 'pagamentos', 'payments'],
  ['invoice', 'fatura', 'faturas', 'invoices'],
  ['billing', 'cobranca', 'cobrancas', 'faturamento'],
  ['subscription', 'assinatura', 'assinaturas', 'subscriptions'],
  ['plan', 'plano', 'planos', 'plans'],
  ['price', 'preco', 'precos', 'prices', 'pricing'],
  ['discount', 'desconto', 'descontos', 'discounts'],
  ['order', 'pedido', 'pedidos', 'orders'],
  ['product', 'produto', 'produtos', 'products'],
  ['report', 'relatorio', 'relatorios', 'reports'],
  ['dashboard', 'painel', 'paineis'],
  ['login', 'entrar', 'acesso', 'signin'],
  ['signup', 'cadastro', 'cadastrar', 'register', 'registro'],
  ['password', 'senha', 'senhas', 'passwords'],
  ['account', 'conta', 'contas', 'accounts'],
  ['seller', 'vendedor', 'vendedores', 'sellers'],
  ['sale', 'venda', 'vendas', 'sales'],
  ['commission', 'comissao', 'comissoes', 'commissions'],
  ['branch', 'filial', 'filiais', 'branches'],
  ['team', 'equipe', 'equipes', 'teams'],
  ['company', 'empresa', 'empresas', 'companies'],
  ['address', 'endereco', 'enderecos', 'addresses'],
  ['search', 'busca', 'buscar', 'pesquisa', 'pesquisar'],
  ['filter', 'filtro', 'filtros', 'filters'],
  ['message', 'mensagem', 'mensagens', 'messages'],
  ['ticket', 'chamado', 'chamados', 'ocorrencia', 'ocorrencias'],
  ['attachment', 'anexo', 'anexos', 'attachments'],
  ['upload', 'envio', 'enviar'],
  ['testimonial', 'testimonials', 'depoimento', 'depoimentos'],
  ['landing', 'home', 'inicio', 'principal'],
  ['copy', 'texto', 'textos', 'conteudo'],
  ['trial', 'teste', 'periodo'],
  ['nav', 'navigation', 'navegacao', 'menu'],
  ['anchor', 'anchors', 'ancora', 'ancoras'],
  ['tooltip', 'dica'],
  ['chart', 'grafico', 'graficos', 'charts'],
  ['date', 'data', 'datas', 'dates'],
  ['name', 'nome', 'nomes', 'names'],
  ['location', 'localizacao', 'local', 'locations', 'cidade'],
];

export type Lexicon = ReadonlyMap<string, readonly string[]>;

function compile(groups: ReadonlyArray<readonly string[]>): Lexicon {
  const lexicon = new Map<string, string[]>();

  for (const group of groups) {
    for (const term of group) {
      const key = term.toLowerCase();
      const others = group.filter((other) => other.toLowerCase() !== key);
      const existing = lexicon.get(key);
      if (existing) existing.push(...others);
      else lexicon.set(key, [...others]);
    }
  }

  return lexicon;
}

/**
 * Compila o léxico a partir dos grupos do projeto.
 *
 * Sem grupos, devolve um léxico vazio e `expandTerms` passa a ser identidade —
 * que é o comportamento padrão, medido como o melhor.
 */
export function buildLexicon(projectGroups: ReadonlyArray<readonly string[]> = []): Lexicon {
  return compile(projectGroups);
}

export function expandTerms(terms: readonly string[], lexicon: Lexicon): string[] {
  const expanded = new Set<string>(terms.map((term) => term.toLowerCase()));

  for (const term of terms) {
    for (const synonym of lexicon.get(term.toLowerCase()) ?? []) {
      expanded.add(synonym.toLowerCase());
    }
  }

  return [...expanded];
}
