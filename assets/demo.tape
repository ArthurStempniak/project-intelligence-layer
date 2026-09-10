# Roteiro do vhs (github.com/charmbracelet/vhs) para regerar a demo em GIF.
#
# O SVG animado em assets/demo.svg funciona no README sem ferramenta nenhuma,
# mas fica desatualizado quando a saida da CLI muda. Este roteiro existe para
# regerar a demo a partir da CLI de verdade:
#
#   winget install charmbracelet.vhs   # ou: brew install vhs
#   cd /um/projeto/de/verdade && pil init && pil scan
#   vhs /caminho/para/assets/demo.tape
#
# Rode num projeto real: uma demo com numeros inventados nao serve de nada.

Output assets/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1100
Set Height 700
Set Theme "Github Dark"
Set TypingSpeed 30ms
Set Padding 20

Type "pil scan"
Enter
Sleep 6s

Type "pil context 'corrigir a conexao com o banco de dados' --budget 8000"
Enter
Sleep 5s

Type "pil impact 'calculateCommission' --min-confidence 0.6"
Enter
Sleep 5s
