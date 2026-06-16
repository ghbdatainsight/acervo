---
name: comecar
description: Use no começo do treinamento pra conectar o aluno ao acervo e dar o primeiro passo — login, listar o que ele tem, e ler/instalar a primeira skill. Dispare quando o aluno disser "começar", "start", "primeiro passo", "me ajuda a começar", "como uso o acervo".
---

# Começar no acervo

Você guia o primeiro contato do aluno com o acervo no Claude Code. Faça em ordem, um passo de cada vez, conversando em português e esperando ele responder antes de seguir:

1. Rode a tool `login` pra conectar a conta dele. Se `whoami` já responde com uma conta, pule este passo.
2. Rode `acervo_listar` e resuma em 1 linha cada skill que ele tem.
3. Pergunte o que ele quer fazer. Ofereça `acervo_buscar` por um tema, ou `acervo_curso` pra ver a apostila do curso.
4. Quando ele escolher uma skill, use `acervo_ler` pra explicar o que ela faz ANTES de instalar; se ele topar, `acervo_instalar` e já use ela na mesma conversa.

Seja breve e prático. Não despeje tudo de uma vez — é o primeiro contato dele.
