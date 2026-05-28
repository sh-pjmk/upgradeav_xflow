// xFlow -> Monday.com | Sync Server

"use strict";
const http = require("http");

//  CONFIG

const XFLOW_BASE     = "https://api.upgrade.xflow.com.br";
const MONDAY_BASE    = "https://api.monday.com/v2";
const MONDAY_VERSION = "2024-01";

const XFLOW_TOKEN  = process.env.XFLOW_TOKEN  || "TwCvirdduSVHbBcLi8CIPNTwzC5qTIgU6yTZJcClNJ7lIVawq4045qGSO0gqFmZM";
const MONDAY_TOKEN = process.env.MONDAY_TOKEN || "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYwMzg3MzQ0OCwiYWFpIjoxMSwidWlkIjo5NjkwNDQzMiwiaWFkIjoiMjAyNi0wMS0wNlQxMjoyMzoyNC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MzI3MzE5NjQsInJnbiI6InVzZTEifQ.o1bfrkdMTBxyWmnJt7sAJJ5-5NabeWapfhchugcAlYQ";

const BOARD = {
  ORCAMENTOS:   18412205084,
  EQUIPAMENTOS: 18412205362,
  LOCAIS:       18412206405,
};

const CFG = {
  FILTRO_DATA_INICIO: "2026-01-01T00:00:00",
  FILTRO_TIPO_DATA:   "DataInicioEvento",
  LOTE_XFLOW:         10,
  LOTE_MONDAY:        5,
  DELAY_LOTE:         300,
  MAX_RETRIES:        5,
  RETRY_BASE:         1000,
  MONDAY_PAGE_SIZE:   500,
  // timeouts via AbortController
  TIMEOUT_XFLOW:      30000,   // 30s por request xFlow
  TIMEOUT_MONDAY:     15000,   // 15s por request Monday
  PORT:               process.env.PORT || 3000,
};

//  mutex simples para evitar execucao concorrente por endpoint
const syncLocks = { orcamentos: false, equipamentos: false, locais: false };

//  LOGGER

const log = {
  info:  (...a) => console.log (`[INFO]  ${new Date().toISOString()}`, ...a),
  warn:  (...a) => console.warn(`[WARN]  ${new Date().toISOString()}`, ...a),
  error: (...a) => console.error(`[ERROR] ${new Date().toISOString()}`, ...a),
  debug: (...a) => console.log (`[DEBUG] ${new Date().toISOString()}`, ...a),
};

//  UTILS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FIX 4: sanitize corrigido - escapa aspas em vez de remover barras
function sanitize(val) {
  if (typeof val !== "string") return val;
  return val
    .replace(/"/g,  "'")   // troca aspas duplas por simples (GraphQL safe)
    .replace(/\n/g, " ")   // remove quebras de linha
    .replace(/\r/g, "")    // remove carriage return
    .replace(/\t/g, " ")   // remove tabs
    .trim();
}

function sanitizeObj(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string")  return sanitize(obj);
  if (typeof obj === "number")  return obj;
  if (typeof obj === "boolean") return obj;
  if (Array.isArray(obj))       return obj.map(sanitizeObj);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitizeObj(v)])
    );
  }
  return obj;
}

async function emLotes(itens, tamanho, fn) {
  const resultados = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    const lote = itens.slice(i, i + tamanho);
    const res  = await Promise.all(lote.map(fn));
    resultados.push(...res);
    if (i + tamanho < itens.length) await sleep(CFG.DELAY_LOTE);
  }
  return resultados;
}

// fetch com timeout via AbortController
async function fetchComTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

//  XFLOW CLIENT

async function xflowGet(path, tentativa = 0) {
  const url = `${XFLOW_BASE}${path}`;
  let res;

  try {
    // FIX 3: timeout no xFlow
    res = await fetchComTimeout(url, { headers: { accept: "text/plain" } }, CFG.TIMEOUT_XFLOW);
  } catch (e) {
    if (tentativa < CFG.MAX_RETRIES) {
      const espera = CFG.RETRY_BASE * Math.pow(2, tentativa);
      log.warn(`xFlow fetch error, retry ${tentativa + 1} em ${espera}ms: ${e.message}`);
      await sleep(espera);
      return xflowGet(path, tentativa + 1);
    }
    throw new Error(`xFlow fetch falhou apos ${CFG.MAX_RETRIES} retries: ${e.message}`);
  }

  if (res.status === 429) {
    if (tentativa >= CFG.MAX_RETRIES) throw new Error(`xFlow 429 limite de retries: ${path}`);
    const espera = CFG.RETRY_BASE * Math.pow(2, tentativa);
    log.warn(`xFlow 429, aguardando ${espera}ms...`);
    await sleep(espera);
    return xflowGet(path, tentativa + 1);
  }

  if (!res.ok) throw new Error(`xFlow HTTP ${res.status} em ${path}`);

  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.retorno !== undefined) return json.retorno;
    return json;
  } catch {
    return text;
  }
}

//  MONDAY CLIENT

async function mondayRequest(query, tentativa = 0) {
  let res;
  try {
    // FIX 3: timeout no Monday
    res = await fetchComTimeout(MONDAY_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": MONDAY_TOKEN,
        "API-Version":   MONDAY_VERSION,
      },
      body: JSON.stringify({ query }),
    }, CFG.TIMEOUT_MONDAY);
  } catch (e) {
    if (tentativa < CFG.MAX_RETRIES) {
      const espera = CFG.RETRY_BASE * Math.pow(2, tentativa);
      log.warn(`Monday fetch error, retry ${tentativa + 1} em ${espera}ms: ${e.message}`);
      await sleep(espera);
      return mondayRequest(query, tentativa + 1);
    }
    throw new Error(`Monday fetch falhou: ${e.message}`);
  }

  if (res.status === 429) {
    if (tentativa >= CFG.MAX_RETRIES) throw new Error("Monday 429 limite de retries");
    const espera = CFG.RETRY_BASE * Math.pow(2, tentativa);
    log.warn(`Monday 429, aguardando ${espera}ms...`);
    await sleep(espera);
    return mondayRequest(query, tentativa + 1);
  }

  const data = await res.json();

  if (data.errors) {
    const msg = JSON.stringify(data.errors);
    log.error(`Monday GraphQL error: ${msg}`);
    log.debug(`Query que causou erro: ${query.substring(0, 300)}...`);
    throw new Error(`Monday GraphQL: ${msg}`);
  }

  return data.data;
}

// Busca TODOS os itens de um board com paginacao
// suporte a chave pelo nome do item (para locais)
async function mondayGetAllItems(boardId, colunaChave) {
  log.info(`Carregando itens do board ${boardId} (chave: ${colunaChave})...`);
  const cache    = new Map();
  let cursor     = null;
  let pagina     = 0;
  const byName   = colunaChave === "name"; // FIX 2: flag para usar item.name

  do {
    pagina++;
    const cursorParam    = cursor ? `, cursor: "${cursor}"` : "";
    const columnValQuery = byName ? "" : `column_values(ids: ["${colunaChave}"]) { id text }`;

    const query = `{
      boards(ids: [${boardId}]) {
        items_page(limit: ${CFG.MONDAY_PAGE_SIZE}${cursorParam}) {
          cursor
          items {
            id
            name
            ${columnValQuery}
          }
        }
      }
    }`;

    const data = await mondayRequest(query);
    const page = data?.boards?.[0]?.items_page;

    if (!page) break;

    for (const item of page.items ?? []) {
      // FIX 2: usa item.name diretamente quando colunaChave === "name"
      const chave = byName
        ? sanitize(item.name ?? "")
        : item.column_values?.[0]?.text;
      if (chave) cache.set(chave, item.id);
    }

    cursor = page.cursor ?? null;
    log.info(`  Pagina ${pagina}: ${page.items?.length ?? 0} itens (cache: ${cache.size})`);
  } while (cursor);

  log.info(`Board ${boardId}: ${cache.size} itens carregados`);
  return cache;
}

// Cria item no Monday
// adiciona create_labels_if_missing para dropdowns
async function mondayCreateItem(boardId, itemName, columnValues) {
  const safeItemName     = sanitize(String(itemName ?? ""));
  const safeColumnValues = sanitizeObj(columnValues);
  const cv               = JSON.stringify(safeColumnValues).replace(/"/g, '\\"');

  const query = `mutation { create_item (board_id: ${boardId}, item_name: "${safeItemName}", column_values: "${cv}", create_labels_if_missing: true) { id } }`;
  const data  = await mondayRequest(query);
  return data?.create_item?.id;
}

// Atualiza item existente no Monday
async function mondayUpdateItem(boardId, itemId, columnValues) {
  const safeColumnValues = sanitizeObj(columnValues);
  const cv               = JSON.stringify(safeColumnValues).replace(/"/g, '\\"');

  const query = `mutation { change_multiple_column_values (board_id: ${boardId}, item_id: ${itemId}, column_values: "${cv}", create_labels_if_missing: true) { id } }`;
  const data  = await mondayRequest(query);
  return data?.change_multiple_column_values?.id;
}

// Upsert usando cache pre-carregado
async function mondayUpsert(boardId, itemName, columnValues, cache, chaveCache) {
  const existingId = cache.get(String(chaveCache));
  if (existingId) {
    await mondayUpdateItem(boardId, existingId, columnValues);
    return { acao: "atualizado", id: existingId };
  } else {
    const newId = await mondayCreateItem(boardId, itemName, columnValues);
    if (newId) cache.set(String(chaveCache), newId);
    return { acao: "criado", id: newId };
  }
}

// fire-and-forget para endpoints longos
// Responde imediatamente e roda o sync em background
function runInBackground(key, fn, res) {
  if (syncLocks[key]) {
    res.writeHead(409);
    res.end(JSON.stringify({ status: "erro", message: `Sync de ${key} ja est em execucao` }));
    return;
  }
  syncLocks[key] = true;
  res.writeHead(200);
  res.end(JSON.stringify({ status: "iniciado", message: `Sync de ${key} rodando em background. Verifique os logs do Railway.` }));

  fn().then((resultado) => {
    log.info(`Background sync ${key} finalizado:`, JSON.stringify(resultado));
  }).catch((e) => {
    log.error(`Background sync ${key} falhou: ${e.message}`);
  }).finally(() => {
    syncLocks[key] = false;
  });
}

//  FETCH XFLOW

async function fetchOrcamentos() {
  const lista = await xflowGet(
    `/BI/Comercial/Orcamento?Token=${XFLOW_TOKEN}&TipoData=${CFG.FILTRO_TIPO_DATA}&DataInicio=${encodeURIComponent(CFG.FILTRO_DATA_INICIO)}`
  );
  const listaArray = Array.isArray(lista) ? lista : [lista];

  const ambientesPorJob = {};
  for (const item of listaArray) {
    if (!ambientesPorJob[item.job]) ambientesPorJob[item.job] = [];
    if (item.ambiente) ambientesPorJob[item.job].push(item.ambiente);
  }

  const jobsVistos = new Set();
  const resultado  = [];
  for (const item of listaArray) {
    if (jobsVistos.has(item.job)) continue;
    jobsVistos.add(item.job);
    resultado.push({
      job:                 item.job                ?? null,
      expectativa:         item.expectativa         ?? null,
      nomeEvento:          item.nome                ?? null,
      cadastradoPor:       item.cadastradoPor       ?? null,
      dataCadastro:        item.dataHora            ?? null,
      status:              item.status              ?? null,
      empresa:             item.empresa             ?? null,
      vendedorResponsavel: item.vendedorResponsavel ?? null,
      inicioEvento:        item.dataInicioEvento    ?? null,
      fimEvento:           item.dataFimEvento       ?? null,
      montagem:            item.dataMontagem        ?? null,
      desmontagem:         item.dataDesmontagem     ?? null,
      dataValidade:        item.dataValidade        ?? null,
      cliente:             item.cliente             ?? null,
      segmento:            item.segmento            ?? null,
      localEvento:         item.localEvento         ?? null,
      ambientes:           ambientesPorJob[item.job] ?? [],
      observacao:          item.observacao          ?? null,
    });
  }
  return resultado;
}

//  SYNC ORCAMENTOS

async function syncOrcamentos() {
  log.info("=== SYNC ORCAMENTOS INICIADO ===");
  const inicio   = Date.now();
  const metricas = { criados: 0, atualizados: 0, erros: 0 };

  const [orcamentos, cache] = await Promise.all([
    fetchOrcamentos(),
    mondayGetAllItems(BOARD.ORCAMENTOS, "text_mm1gzmk9"),
  ]);

  log.info(`${orcamentos.length} orcamentos para processar`);

  await emLotes(orcamentos, CFG.LOTE_MONDAY, async (orc) => {
    try {
      const itemName     = `${orc.job ?? ""} - ${orc.nomeEvento ?? ""}`;
      const columnValues = {
        text_mm1gzmk9:      String(orc.job ?? ""),
        text_mm1gt9pm:      orc.cliente ?? "",
        text_mm1gcke8:      orc.localEvento ?? "",
        color_mm1gp3b5:     { label: orc.status ?? "" },
        date_mm1gm5t8:      orc.inicioEvento  ? { date: orc.inicioEvento.split("T")[0] }  : {},
        date_mm1g2zzq:      orc.fimEvento     ? { date: orc.fimEvento.split("T")[0] }     : {},
        numeric_mm34vtan:   orc.expectativa ?? 0,
        text_mm34a7xt:      orc.cadastradoPor ?? "",
        date_mm34q2na:      orc.dataCadastro  ? { date: orc.dataCadastro.split("T")[0] }  : {},
        text_mm346t9w:      orc.empresa ?? "",
        text_mm34m633:      orc.vendedorResponsavel ?? "",
        date_mm34rjhs:      orc.montagem      ? { date: orc.montagem.split("T")[0] }      : {},
        date_mm34cgbg:      orc.desmontagem   ? { date: orc.desmontagem.split("T")[0] }   : {},
        date_mm341yek:      orc.dataValidade  ? { date: orc.dataValidade.split("T")[0] }  : {},
        text_mm34ecgx:      orc.segmento ?? "",
        long_text_mm34gay0: { text: Array.isArray(orc.ambientes) ? orc.ambientes.join(", ") : "" },
        long_text_mm348zqg: { text: orc.observacao ?? "" },
      };

      const { acao } = await mondayUpsert(BOARD.ORCAMENTOS, itemName, columnValues, cache, String(orc.job));
      metricas[acao === "criado" ? "criados" : "atualizados"]++;
    } catch (e) {
      metricas.erros++;
      log.error(`Orcamento ${orc.job}: ${e.message}`);
    }
  });

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  log.info(`=== SYNC ORCAMENTOS CONCLUIDO em ${seg}s | criados: ${metricas.criados} | atualizados: ${metricas.atualizados} | erros: ${metricas.erros} ===`);
  return { status: "ok", duracao: `${seg}s`, ...metricas };
}

//  SYNC EQUIPAMENTOS

async function syncEquipamentos() {
  log.info("=== SYNC EQUIPAMENTOS INICIADO ===");
  const inicio   = Date.now();
  const metricas = { criados: 0, atualizados: 0, erros: 0 };

  const orcamentos = await fetchOrcamentos();

  // cache usando coluna text_mm1gzmk9 (job) - chave nica composta
  //  adicionada ao cache em memoria no upsert
  const cache = await mondayGetAllItems(BOARD.EQUIPAMENTOS, "text_mm1gzmk9");

  const resultadosAmbientes = await emLotes(orcamentos, CFG.LOTE_XFLOW, async (orc) => {
    if (!orc.job) return { orc, ambientes: [] };
    try {
      const amb = await xflowGet(`/Comercial/Orcamento/Ambiente?Token=${XFLOW_TOKEN}&IDOrcamento=${orc.job}`);
      return { orc, ambientes: Array.isArray(amb) ? amb : [amb] };
    } catch (e) {
      log.warn(`Ambientes job ${orc.job}: ${e.message}`);
      return { orc, ambientes: [] };
    }
  });

  const todosAmbientes = [];
  for (const { orc, ambientes } of resultadosAmbientes) {
    for (const ambiente of ambientes) {
      const idAmbiente = ambiente.id ?? ambiente.idAmbiente ?? ambiente.IDAmbiente;
      if (!idAmbiente) continue;
      todosAmbientes.push({ orc, ambiente, idAmbiente });
    }
  }
  log.info(`${todosAmbientes.length} ambientes encontrados`);

  await emLotes(todosAmbientes, CFG.LOTE_XFLOW, async ({ orc, ambiente, idAmbiente }) => {
    const nomeAmbiente = ambiente.nomeAmbiente ?? "";

    let listaEquip = [];
    let listaProd  = [];

    try {
      const r = await xflowGet(`/Comercial/Orcamento/Ambiente/Equipamento?Token=${XFLOW_TOKEN}&IDAmbiente=${idAmbiente}`);
      listaEquip = Array.isArray(r) ? r : [r];
    } catch (e) {
      log.warn(`Equipamentos ambiente ${idAmbiente}: ${e.message}`);
    }

    try {
      const r = await xflowGet(`/Comercial/Orcamento/Ambiente/Producao?Token=${XFLOW_TOKEN}&IDAmbiente=${idAmbiente}`);
      listaProd = Array.isArray(r) ? r : [r];
    } catch (e) {
      log.warn(`Producao ambiente ${idAmbiente}: ${e.message}`);
    }

    for (const equip of listaEquip) {
      if (!equip) continue;
      try {
        // chave composta usando job + idAmbiente + id do equipamento
        const chaveUnica   = `${orc.job}-${idAmbiente}-${equip.id ?? equip.idEquipamento ?? equip.idOrcamentoAmbiente}`;
        const itemName     = `${orc.job} - ${nomeAmbiente} - ${equip.descricaoComercial ?? ""}`;
        const columnValues = {
          // FIX 1: salva a chave composta em coluna texto para persistncia
          text_mm1gzmk9:     chaveUnica,
          numeric_mm349zve:  orc.job ?? 0,
          text_mm34y3y5:     orc.nomeEvento ?? "",
          text_mm346fra:     equip.descricaoComercial ?? "",
          text_mm34ms24:     nomeAmbiente,
          text_mm34spef:     equip.nomeSistema ?? "",
          // dropdown: create_labels_if_missing ja est no mondayCreateItem/Update
          dropdown_mm34p57h: { labels: [equip.categoria ?? ""] },
          numeric_mm34s3tn:  equip.quantidade ?? 0,
        };
        const { acao } = await mondayUpsert(BOARD.EQUIPAMENTOS, itemName, columnValues, cache, chaveUnica);
        metricas[acao === "criado" ? "criados" : "atualizados"]++;
      } catch (e) {
        metricas.erros++;
        log.error(`Equipamento ambiente ${idAmbiente}: ${e.message}`);
      }
    }

    for (const prod of listaProd) {
      if (!prod) continue;
      try {
        const chaveUnica   = `prod-${orc.job}-${idAmbiente}-${prod.id ?? prod.idProducao ?? prod.idOrcamentoAmbiente}`;
        const itemName     = `${orc.job} - ${nomeAmbiente} - ${prod.descricaoComercial ?? ""} (Prod)`;
        const columnValues = {
          text_mm1gzmk9:     chaveUnica,
          numeric_mm349zve:  orc.job ?? 0,
          text_mm34y3y5:     orc.nomeEvento ?? "",
          text_mm346fra:     prod.descricaoComercial ?? "",
          text_mm34ms24:     nomeAmbiente,
          text_mm34spef:     prod.nomeSistema ?? "",
          dropdown_mm34p57h: { labels: [prod.categoria ?? ""] },
          numeric_mm34s3tn:  prod.quantidade ?? 0,
        };
        const { acao } = await mondayUpsert(BOARD.EQUIPAMENTOS, itemName, columnValues, cache, chaveUnica);
        metricas[acao === "criado" ? "criados" : "atualizados"]++;
      } catch (e) {
        metricas.erros++;
        log.error(`Producao ambiente ${idAmbiente}: ${e.message}`);
      }
    }
  });

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  log.info(`=== SYNC EQUIPAMENTOS CONCLUIDO em ${seg}s | criados: ${metricas.criados} | atualizados: ${metricas.atualizados} | erros: ${metricas.erros} ===`);
  return { status: "ok", duracao: `${seg}s`, ...metricas };
}

//  SYNC LOCAIS

async function syncLocais() {
  log.info("=== SYNC LOCAIS INICIADO ===");
  const inicio   = Date.now();
  const metricas = { criados: 0, atualizados: 0, erros: 0 };

  const lista  = await xflowGet(`/Comercial/LocalEvento?Token=${XFLOW_TOKEN}`);
  const locais = (Array.isArray(lista) ? lista : [lista]).filter(l => l && l.nome);

  // FIX 2: usa "name" para buscar pelo nome do item diretamente
  const cache = await mondayGetAllItems(BOARD.LOCAIS, "name");

  log.info(`${locais.length} locais para processar`);

  await emLotes(locais, CFG.LOTE_MONDAY, async (local) => {
    try {
      const itemName     = local.nome;
      const chaveCache   = sanitize(itemName); // FIX 2: chave = nome sanitizado
      const columnValues = {
        text_mm34g89g:      local.logradouro  ?? "",
        text_mm344zdw:      local.numero      ?? "",
        text_mm34a36v:      local.complemento ?? "",
        text_mm34k7rj:      local.bairro      ?? "",
        text_mm34kkqe:      local.estado      ?? "",
        text_mm34xr9q:      local.municipio   ?? "",
        text_mm34djy4:      local.pais        ?? "",
        phone_mm34n5r1:     { phone: String(local.telefone ?? ""), countryShortName: "BR" },
        long_text_mm34644g: { text: local.observacao ?? "" },
        long_text_mm34859w: { text: Array.isArray(local.ambientes) ? local.ambientes.join(", ") : "" },
      };
      const { acao } = await mondayUpsert(BOARD.LOCAIS, itemName, columnValues, cache, chaveCache);
      metricas[acao === "criado" ? "criados" : "atualizados"]++;
    } catch (e) {
      metricas.erros++;
      log.error(`Local ${local.nome}: ${e.message}`);
    }
  });

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  log.info(`=== SYNC LOCAIS CONCLUIDO em ${seg}s | criados: ${metricas.criados} | atualizados: ${metricas.atualizados} | erros: ${metricas.erros} ===`);
  return { status: "ok", duracao: `${seg}s`, ...metricas };
}

//  ENDPOINTS DE CONSULTA

async function queryOrcamentos() {
  const inicio    = Date.now();
  const resultado = await fetchOrcamentos();
  const seg       = ((Date.now() - inicio) / 1000).toFixed(1);
  return { status: "ok", duracao: `${seg}s`, total: resultado.length, data: resultado };
}

async function queryLocais() {
  const inicio = Date.now();
  const lista  = await xflowGet(`/Comercial/LocalEvento?Token=${XFLOW_TOKEN}`);
  const resultado = (Array.isArray(lista) ? lista : [lista]).filter(l => l).map(local => ({
    nome:        local.nome        ?? null,
    logradouro:  local.logradouro  ?? null,
    numero:      local.numero      ?? null,
    complemento: local.complemento ?? null,
    bairro:      local.bairro      ?? null,
    estado:      local.estado      ?? null,
    municipio:   local.municipio   ?? null,
    pais:        local.pais        ?? null,
    telefone:    local.telefone    ?? null,
    observacao:  local.observacao  ?? null,
    ambientes:   local.ambientes   ?? [],
  }));
  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  return { status: "ok", duracao: `${seg}s`, total: resultado.length, data: resultado };
}

//  SERVIDOR HTTP

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  log.info(`${req.method} ${url}`);
  res.setHeader("Content-Type", "application/json");

  try {
    // equipamentos e locais usam fire-and-forget para evitar SSL timeout
    if (url === "/sync/equipamentos") {
      runInBackground("equipamentos", syncEquipamentos, res);
      return;
    }
    if (url === "/sync/locais") {
      runInBackground("locais", syncLocais, res);
      return;
    }

    let resultado;

    if      (url === "/orcamentos")        resultado = await queryOrcamentos();
    else if (url === "/locais")            resultado = await queryLocais();
    else if (url === "/sync/orcamentos")   resultado = await syncOrcamentos();
    else if (url === "/health")            resultado = { status: "ok", timestamp: new Date().toISOString(), locks: syncLocks };
    else {
      res.writeHead(404);
      res.end(JSON.stringify({
        status:  "erro",
        message: "Endpoints: /sync/orcamentos | /sync/equipamentos | /sync/locais | /orcamentos | /locais | /health",
      }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify(resultado));
  } catch (e) {
    log.error(`Erro no endpoint ${url}: ${e.message}`);
    res.writeHead(500);
    res.end(JSON.stringify({ status: "erro", message: e.message }));
  }
});

server.listen(CFG.PORT, () => {
  log.info(`Servidor rodando na porta ${CFG.PORT}`);
  log.info("Endpoints: /sync/orcamentos | /sync/equipamentos | /sync/locais | /orcamentos | /locais | /health");
});
