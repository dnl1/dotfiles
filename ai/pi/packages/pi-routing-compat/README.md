# Compatibilidade entre roteamento automático e Codex

Este pacote local mantém o roteador do `pi-auto-model@0.9.1` e o provedor do `pi-codex-native@0.3.13`. As cópias ficam em `vendor/`; os pacotes npm originais continuam instalados, com suas extensões desativadas para evitar registros duplicados.

## Correções

- Preserva o raciocínio do modelo de destino. O serializador do Codex continua responsável pela conversão do histórico Responses.
- Identifica o modelo real de cada tentativa do proxy com `AsyncLocalStorage`, separado por sessão, para validar e restaurar o checkpoint correto.
- Deixa a compactação nativa com o Codex e salva também um resumo legível para outros provedores. O resumo recebe o checkpoint anterior em uma requisição SSE isolada.
- Impede uma troca automática para outro provedor quando o checkpoint antigo só tem o marcador `[OpenAI native compaction checkpoint]`. Execute `/compact` para criar o resumo legível antes da troca.
- Usa os contratos de contexto e ferramentas adicionais do Pi 1.4, incluindo mensagens de extensão sem `prompt`.
- Mantém a regra de fallback: depois de emitir texto ou chamada de ferramenta, a tentativa não pode ser repetida em outro modelo.

Cada compactação nativa passa a incluir uma requisição adicional para o resumo legível. Ela consome tokens. Se o resumo falhar, a compactação é cancelada, preservando o histórico anterior.

## Uso

Execute `/reload` e `/auto-model on`, ou selecione `pi-auto-model/auto` em `/model`. Pools, pesos e regras continuam em `~/.pi/agent/auto-model.json`.

Para esta sessão antiga, execute `/compact` com Codex selecionado antes de ativar o modo automático. Novas compactações já incluem os dois formatos.

## Testes

```bash
PI_SESSION_FILE=/caminho/da/sessao.jsonl bash test/run.sh
```

O conjunto verificado tem 183 testes e um smoke test do SDK, que carrega o pacote e despacha pelo roteador. Inclui o histórico local, compactação com resumo legível e transporte Codex com resposta SSE simulada. Não faz inferência paga nem escreve na sessão capturada.

Quatro casos do pacote original ficam fora da execução: dois testes dependem de `pi-context-windows`, um de `pi-skills` e um exige compilar o binário Rust. O último é filtrado pelo nome; os três arquivos com imports ausentes são omitidos. Essas dependências também faltam antes deste patch.

## Atualizações e reversão

As cópias locais não são atualizadas pelo npm. Ao mudar a versão de qualquer pacote, reaplique e teste as alterações de `compat.patch`.

Para reverter, retire `./packages/pi-routing-compat` de `settings.json`, reative as extensões dos dois pacotes npm e execute `/reload`. Isso restaura também o conflito original. Há um backup `settings.json.bak-routing-*` anterior à ativação.
