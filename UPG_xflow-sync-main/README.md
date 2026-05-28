# xflow-sync

Servidor HTTP em Node.js que consome a API do xFlow e expõe os dados via endpoints JSON. Foi desenvolvido para ser consumido pelo n8n, que por sua vez sincroniza os dados com os quadros do Monday.com.

O servidor está hospedado no Railway e fica disponível 24/7, sendo chamado pelo n8n em intervalos programados.

---

## Como funciona

O xFlow é o sistema de gestão de orçamentos e eventos do cliente. Sua API retorna os dados em formato JSON, mas exige múltiplas requisições encadeadas para montar as informações completas — por exemplo, para obter os equipamentos de um orçamento é necessário primeiro buscar os ambientes, e só então buscar os equipamentos de cada ambiente.

Este servidor abstrai toda essa complexidade e entrega os dados já consolidados em três endpoints simples.

---

## Endpoints

### `GET /orcamentos`
Retorna a lista completa de orçamentos com os ambientes já agrupados por job. Tempo médio de resposta: ~2s.

### `GET /equipamentos`
Retorna todos os equipamentos e itens de produção organizados por job e ambiente. Realiza requisições encadeadas para todos os ambientes de todos os orçamentos. Tempo médio de resposta: ~285s.

### `GET /locais`
Retorna o cadastro completo de locais de evento. Tempo médio de resposta: ~1s.

### `GET /health`
Verifica se o servidor está no ar. Usar para monitoramento.

---

## Hospedagem

O servidor está hospedado no **Railway** e roda continuamente. A URL pública é gerada pelo Railway em Settings → Networking → Generate Domain.

Para acessar os dados basta fazer uma requisição GET para qualquer um dos endpoints acima usando a URL pública do Railway.

---

## Rodar localmente

```bash
node xflow-get.js
```

Servidor disponível em `http://localhost:3000`
