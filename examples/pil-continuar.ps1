<#
.SYNOPSIS
  Monta um prompt para retomar um trabalho em andamento, juntando o que o PIL
  sabe do projeto com o que só o git sabe: suas alterações não commitadas.

.DESCRIPTION
  O `pil context --raw` já produz um prompt completo, mas ele descreve o código
  como está indexado. Quando você parou no meio de uma alteração, o que importa
  mais é o que você já mudou — e isso vive no working tree.

  O script:
    1. roda `pil scan` (incremental) para o índice refletir o disco;
    2. descobre pelo git o que você alterou e força esses arquivos no contexto
       via --include, para o PIL não ter que adivinhar onde você parou;
    3. inclui o diff, que é a única fonte do que você pretendia fazer;
    4. imprime o prompt, ou copia para a área de transferência.

  IMPORTANTE: o passo 2 só funciona se o projeto for um repositório git próprio.
  Num projeto não rastreado, o git reporta *todos* os arquivos como novos e não
  há sinal nenhum sobre onde você estava — o script detecta isso, avisa e segue
  apenas com o contexto do PIL.

.PARAMETER Tarefa
  O que você quer continuar, em linguagem natural.

.PARAMETER Budget
  Teto de tokens do contexto do PIL. Padrão 20000.

.PARAMETER Clipboard
  Copia o resultado para a área de transferência em vez de imprimir.

.EXAMPLE
  .\pil-continuar.ps1 "terminar a validacao de CNPJ no cadastro" -Clipboard

.EXAMPLE
  .\pil-continuar.ps1 "continuar o refactor do pool de conexao" -Budget 30000 > prompt.md
#>

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Tarefa,

  [int]$Budget = 20000,

  [switch]$Clipboard
)

$ErrorActionPreference = 'Stop'

<#
  Acima deste número de arquivos alterados, o git deixou de ser sinal.

  Ninguém retoma um trabalho espalhado por 40 arquivos ao mesmo tempo. Quando a
  contagem passa disso, quase sempre significa que o projeto não é um repo
  próprio e o git está reportando o projeto inteiro como novo — foi o que
  aconteceu no primeiro teste, com 246 arquivos "alterados" e o script travando
  ao montar --include para todos.
#>
$LimiteAlterados = 40

# ---------------------------------------------------------------- 1. índice
Write-Host 'Atualizando o índice...' -ForegroundColor DarkGray
pil scan --quiet | Out-Null

# ------------------------------------------------------- 2. o que você mexeu
#
# stderr do git é silenciado porque aviso de fim de linha (LF/CRLF) virá
# ErrorRecord no PowerShell 5.1 e abortaria o script sem nada de errado.

$alterados = @()
$novos = @()
$diff = ''
$avisoGit = ''

$anterior = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

$raiz = (git rev-parse --show-toplevel 2>$null | Select-Object -First 1)

if (-not $raiz) {
  $avisoGit = 'Este diretório não está em um repositório git.'
} else {
  $aqui = (Get-Location).Path -replace '\\', '/'
  $ehRaiz = $aqui.TrimEnd('/').Equals($raiz.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)

  # Só o que interessa, e em duas chamadas — nunca uma por arquivo.
  # `--relative ... -- .` escopa ao diretório atual e devolve caminho relativo
  # a ele, necessário porque a raiz do repo pode estar bem acima do projeto.
  $modificados = @(git diff --relative HEAD --name-only --diff-filter=d -- . 2>$null)
  $naoRastreados = @(git ls-files --others --exclude-standard -- . 2>$null)

  $extensoes = '\.(ts|tsx|js|jsx|mjs|cjs|py)$'
  $modificados = @($modificados | Where-Object { $_ -and $_ -match $extensoes })
  $naoRastreados = @($naoRastreados | Where-Object { $_ -and $_ -match $extensoes })

  $total = $modificados.Count + $naoRastreados.Count

  if ($total -gt $LimiteAlterados) {
    $avisoGit = if ($ehRaiz) {
      "O git reporta $total arquivos alterados — demais para ser um trabalho em andamento."
    } else {
      "Este projeto não é um repositório git próprio (a raiz é $raiz), " +
      "então o git reporta $total arquivos como novos. Rode ``git init`` aqui " +
      'para que o script consiga distinguir o que você alterou.'
    }
  } else {
    $modificados = @($modificados)
    $novos = @($naoRastreados)
    $alterados = @($modificados + $novos | Select-Object -Unique)

    if ($modificados.Count -gt 0) {
      $diff = (git diff --relative HEAD -- $modificados 2>$null | Out-String)
    }
  }
}

$ErrorActionPreference = $anterior

if ($avisoGit) {
  Write-Host "Aviso: $avisoGit" -ForegroundColor Yellow
  Write-Host 'Seguindo apenas com o contexto do PIL.' -ForegroundColor DarkGray
}

# ------------------------------------------------------- 3. contexto do PIL
#
# `--include-from` em vez de um `--include` por arquivo: a linha de comando do
# Windows tem teto de ~32 KB, e passar caminho por argumento estourava com
# `Falha na execucao do programa 'node.exe': O nome do arquivo ou a extensao e
# muito grande`. Uma lista gerada por script e exatamente o caso em que isso
# acontece.
$listaTemp = $null
$argumentos = @()

if ($alterados.Count -gt 0) {
  $listaTemp = Join-Path ([System.IO.Path]::GetTempPath()) "pil-include-$PID.txt"
  Set-Content -Path $listaTemp -Value $alterados -Encoding utf8
  $argumentos = @('--include-from', $listaTemp)
}

try {
  $contexto = (pil context $Tarefa --budget $Budget --raw @argumentos | Out-String)
} finally {
  if ($listaTemp -and (Test-Path $listaTemp)) { Remove-Item $listaTemp -Force }
}

# ----------------------------------------------------------- 4. o prompt
$partes = [System.Collections.Generic.List[string]]::new()

$partes.Add(@"
Estou retomando um trabalho em andamento neste projeto. Abaixo vão, nesta ordem:
o que eu quero fazer, o que já alterei e ainda não commitei, e o contexto
relevante do restante do código.

Não reescreva o que já está feito: continue de onde eu parei. Se algo que eu já
alterei parecer incompleto ou incorreto, aponte isso antes de seguir.

# O QUE QUERO FAZER
$Tarefa
"@)

if ($alterados.Count -gt 0) {
  $bloco = @"

# O QUE EU JA ALTEREI (ainda nao commitado)
"@

  if ($modificados.Count -gt 0) {
    $lista = ($modificados | ForEach-Object { "- $_" }) -join "`n"
    $bloco += @"

Modificados:
$lista

``````diff
$diff
``````
"@
  }

  if ($novos.Count -gt 0) {
    $lista = ($novos | ForEach-Object { "- $_" }) -join "`n"
    $bloco += @"

Arquivos novos, sem historico no git. O conteudo atual deles esta no contexto
abaixo, forcado via --include:
$lista
"@
  }

  $partes.Add($bloco)
} else {
  $motivo = if ($avisoGit) { " ($avisoGit)" } else { '' }
  $partes.Add(@"

# O QUE EU JA ALTEREI
Nao foi possivel determinar pelo git$motivo. Considere o contexto abaixo como o
estado atual do codigo e me pergunte se precisar saber o que eu ja tinha mexido.
"@)
}

$partes.Add(@"

# CONTEXTO DO PROJETO (selecionado automaticamente)

O bloco abaixo foi montado pelo PIL: e o subconjunto do projeto julgado
relevante para esta tarefa, nao o projeto inteiro. Trechos marcados como
assinatura mostram so o contrato, sem implementacao. Se faltar algo que voce
precise ver, peca explicitamente em vez de supor que nao existe.

$contexto
"@)

$prompt = $partes -join "`n"

if ($Clipboard) {
  Set-Clipboard -Value $prompt
  $kb = [math]::Round($prompt.Length / 1024, 1)
  Write-Host "Prompt copiado ($kb KB). Cole no chat do Claude." -ForegroundColor Green
} else {
  $prompt
}
