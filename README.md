# Acervo — conector pro Claude Code

Conecta o seu **Claude Code** ao seu acervo: você faz login com a sua conta e
**instala as skills e materiais que são seus** direto no projeto — sem baixar,
copiar ou colar arquivo.

## Pré-requisito
- **Node.js** instalado (`node -v` deve responder uma versão).

## 1. Instalar (uma vez)
No Claude Code:

```
/plugin marketplace add ghbdatainsight/acervo
/plugin install acervo@ghbdatainsight
```

Reinicie o Claude Code se ele pedir.

## 2. Conectar a sua conta (uma vez)
```
login
```

Abre o navegador → clique **Conectar terminal**. Se você já estiver logado, é um
clique só.

## 3. Usar
- **`whoami`** — mostra a sua conta e o que você tem acesso
- *"lista o meu acervo"*
- *"busca <assunto> no acervo"*
- *"instala a skill <nome>"* → vai pra `.claude/skills/<nome>/`

O que você puxa respeita o seu acesso (só o que foi liberado pra você).
