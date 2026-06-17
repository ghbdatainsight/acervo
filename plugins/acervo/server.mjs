#!/usr/bin/env node
/**
 * Acervo MCP — server stdio local que expõe o acervo do workshop como tools no
 * Claude Code.
 *
 * DOIS MODOS:
 *  - HTTP/auth (quando ACERVO_PORTAL_URL está setado): autentica no portal
 *    (pareamento via /connect → token Bearer) e puxa conteúdo COM ESCOPO por
 *    aluno. É o modelo de verdade.
 *  - Local (sem ACERVO_PORTAL_URL): lê content/ local, sem auth. Demo/offline.
 *
 * Token guardado em ~/.acervo-mcp/credentials.json (por URL de portal).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import http from "http";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Por padrão fala com o portal de produção. Override por env (ACERVO_PORTAL_URL).
// Modo local (lê content/ do disco, sem auth) só quando ACERVO_CONTENT_DIR é setado.
const PORTAL_URL = (
  process.env.ACERVO_PORTAL_URL || "https://workshop.ghbdatainsight.com"
).replace(/\/+$/, "");
const MODE = process.env.ACERVO_CONTENT_DIR ? "local" : "http";

const CONTENT_DIR =
  process.env.ACERVO_CONTENT_DIR ||
  path.resolve(__dirname, "..", "website", "content");

const CRED_FILE = path.join(os.homedir(), ".acervo-mcp", "credentials.json");
const SLUG_RE = /^[a-z0-9-]+$/;
const BINARY_EXT = new Set([
  ".ttf", ".otf", ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".gif",
  ".webp", ".ico", ".pdf", ".zip", ".mp4", ".mov", ".mp3", ".wav"
]);

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

function fold(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* ============================ credenciais ============================ */

async function loadToken() {
  try {
    const j = JSON.parse(await fs.readFile(CRED_FILE, "utf8"));
    return j[PORTAL_URL] || null;
  } catch {
    return null;
  }
}
async function saveToken(token) {
  let j = {};
  try {
    j = JSON.parse(await fs.readFile(CRED_FILE, "utf8"));
  } catch {
    /* primeiro uso */
  }
  j[PORTAL_URL] = token;
  await fs.mkdir(path.dirname(CRED_FILE), { recursive: true });
  await fs.writeFile(CRED_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
}

/* ============================ modo HTTP ============================ */

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* sem browser — o usuário abre o link na mão */
  }
}

async function toolLogin(args) {
  if (MODE !== "http") {
    return text("Modo local (sem ACERVO_PORTAL_URL) não precisa de login.", true);
  }
  // fallback: colar o código direto
  if (args?.code) {
    await saveToken(String(args.code).trim());
    const who = await fetchMe();
    return text(
      who.ok ? `Conectado como ${who.data.email}.` : `Token salvo, mas falhou validar (${who.status}).`,
      !who.ok
    );
  }

  const state = randomBytes(16).toString("hex");
  const server = http.createServer();
  const tokenPromise = new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/cb") return res.writeHead(404).end();
      const token = u.searchParams.get("token");
      if (state && u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        return res.end("<h2>State inválido.</h2>");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>Terminal conectado ✓</h2><p>Pode fechar e voltar pro Claude Code.</p>");
      server.close();
      token ? resolve(token) : reject(new Error("sem token"));
    });
    server.on("error", reject);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `${PORTAL_URL}/connect?port=${port}&state=${state}`;
  openBrowser(url);

  const token = await Promise.race([
    tokenPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 180000))
  ]).catch((e) => {
    server.close();
    return { __err: e.message };
  });
  if (token && token.__err) {
    return text(
      `Não consegui parear (${token.__err}). Abra este link e clique em "Conectar terminal":\n${url}`,
      true
    );
  }
  await saveToken(token);
  const who = await fetchMe();
  return text(
    who.ok
      ? `Conectado como ${who.data.full_name || who.data.email} (${who.data.email}). Use acervo_listar / acervo_instalar.`
      : "Token salvo."
  );
}

async function fetchMe() {
  const token = await loadToken();
  if (!token) return { ok: false, status: 0, needLogin: true };
  const r = await fetch(`${PORTAL_URL}/api/portal/mcp/me`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, data: await r.json() };
}

const NEED_LOGIN = text("Não conectado. Rode `login` primeiro.", true);

async function httpWhoami() {
  const me = await fetchMe();
  if (me.needLogin) return NEED_LOGIN;
  if (!me.ok) return text(`Falha (${me.status}). Talvez precise logar de novo: rode \`login\`.`, true);
  const d = me.data;
  const byKind = { skill: 0, prompt: 0, doc: 0 };
  for (const r of d.resources || []) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return text(
    `${d.full_name || d.email} (${d.email})${d.isAdmin ? " — ADMIN" : ""}\n` +
      `cohort: ${d.cohort_id ?? "—"}\n` +
      `acesso: ${byKind.skill} skills, ${byKind.prompt} prompts, ${byKind.doc} docs`
  );
}

async function httpListar() {
  const me = await fetchMe();
  if (me.needLogin) return NEED_LOGIN;
  if (!me.ok) return text(`Falha (${me.status}).`, true);
  const res = me.data.resources || [];
  if (!res.length) return text("Você não tem recursos atribuídos ainda.");
  const fmt = (k) =>
    res.filter((r) => r.kind === k).map((r) => `  • ${r.slug} — ${r.name}`).join("\n");
  return text(
    `Seu acervo (${res.length}):\n\nSKILLS:\n${fmt("skill") || "  —"}\n\nPROMPTS:\n${fmt("prompt") || "  —"}\n\nDOCS:\n${fmt("doc") || "  —"}`
  );
}

async function httpBuscar(args) {
  const query = String(args?.query ?? "").trim();
  if (query.length < 2) return text("Busca precisa de ao menos 2 caracteres.", true);
  const token = await loadToken();
  if (!token) return NEED_LOGIN;
  const blocks = [];
  for (const kind of ["skill", "prompt", "doc"]) {
    const r = await fetch(
      `${PORTAL_URL}/api/resources/search?kind=${kind}&q=${encodeURIComponent(query)}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (r.status === 401) return text("Sessão expirada. Rode `login` de novo.", true);
    if (!r.ok) continue;
    const { results } = await r.json();
    for (const hit of results || []) {
      const files = (hit.matchedFiles || [])
        .slice(0, 3)
        .map((f) => `    ${f.path}: ${f.snippet}`)
        .join("\n");
      blocks.push(`• [${kind}] ${hit.slug} — ${hit.name}` + (files ? `\n${files}` : ""));
    }
  }
  return text(
    blocks.length
      ? `${blocks.length} resultado(s) para "${query}":\n\n${blocks.join("\n")}`
      : `Nada no seu acervo para "${query}".`
  );
}

async function httpLer(args) {
  const slug = String(args?.slug ?? "").trim();
  const wantPath = String(args?.path ?? "").trim();
  if (!SLUG_RE.test(slug)) return text(`Slug inválido: "${slug}".`, true);
  const token = await loadToken();
  if (!token) return NEED_LOGIN;
  const me = await fetchMe();
  if (me.needLogin) return NEED_LOGIN;
  if (!me.ok) return text(`Falha (${me.status}).`, true);
  const found = (me.data.resources || []).find((r) => r.slug === slug);
  if (!found) return text(`"${slug}" não está no seu acervo.`, true);
  const kind = found.kind;
  const candidates = wantPath
    ? [wantPath]
    : ["SKILL.md", "README.md", "skill.md", "prompt.md"];
  for (const p of candidates) {
    const r = await fetch(
      `${PORTAL_URL}/api/resources/${kind}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(p)}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (r.status === 401) return text("Sessão expirada. Rode `login` de novo.", true);
    if (!r.ok) continue;
    const data = await r.json();
    if (data.status === "text") {
      return text(`# ${found.name} — ${p}\n\n${data.content}`);
    }
    if (data.status === "binary" || data.status === "toolarge") {
      const why = data.status === "binary" ? "binário" : "grande demais";
      return text(`"${p}" é ${why}; instale a skill (acervo_instalar) pra abrir.`, true);
    }
  }
  return text(
    wantPath
      ? `Não achei "${wantPath}" em ${slug}.`
      : `Não achei um arquivo principal em ${slug}. Passe path=<arquivo> (use acervo_buscar pra ver os caminhos).`,
    true
  );
}

async function httpCurso(args) {
  const token = await loadToken();
  if (!token) return NEED_LOGIN;
  const query = String(args?.query ?? "").trim();
  const lesson = String(args?.lesson ?? "").trim();
  const qs = lesson
    ? `?lesson=${encodeURIComponent(lesson)}`
    : query
      ? `?q=${encodeURIComponent(query)}`
      : "";
  const r = await fetch(`${PORTAL_URL}/api/portal/mcp/course${qs}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (r.status === 401) return text("Sessão expirada. Rode `login` de novo.", true);
  if (r.status === 403) {
    const e = await r.json().catch(() => ({}));
    return text(
      e.error === "course_pending"
        ? "Seu curso ainda não foi liberado pela organização."
        : "Você não tem o curso liberado.",
      true
    );
  }
  if (r.status === 404) return text("Conteúdo do curso indisponível.", true);
  if (!r.ok) return text(`Falha (${r.status}).`, true);
  const data = await r.json();
  if (lesson) return text(data.text || "Lição vazia.");
  if (query) {
    const hits = data.results || [];
    return text(
      hits.length
        ? `${hits.length} resultado(s) na apostila para "${query}":\n\n` +
            hits.map((h) => `• [${h.sec}] ${h.title} (lesson=${h.id})\n    ${h.snippet}`).join("\n")
        : `Nada na apostila para "${query}".`
    );
  }
  const lessons = data.lessons || [];
  return text(
    `Apostila: ${data.title} (${lessons.length} lições)\n\n` +
      lessons.map((l) => `• [${l.sec}] ${l.title} — ${l.time} (lesson=${l.id})`).join("\n")
  );
}

async function httpInstalar(args) {
  const slug = String(args?.slug ?? "").trim();
  const force = args?.force === true;
  if (!SLUG_RE.test(slug)) return text(`Slug inválido: "${slug}".`, true);
  const token = await loadToken();
  if (!token) return NEED_LOGIN;

  const dest = path.join(process.cwd(), ".claude", "skills", slug);
  try {
    if ((await fs.stat(dest)).isDirectory() && !force) {
      return text(
        `Já existe ${path.relative(process.cwd(), dest)}. Rode com force=true pra sobrescrever.`,
        true
      );
    }
  } catch {
    /* não existe */
  }

  const r = await fetch(`${PORTAL_URL}/api/resources/skill/${encodeURIComponent(slug)}/download`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (r.status === 401) return text("Sessão expirada. Rode `login` de novo.", true);
  if (r.status === 403) return text(`Você não tem acesso à skill "${slug}".`, true);
  if (r.status === 404) return text(`Skill "${slug}" não encontrada.`, true);
  if (!r.ok) return text(`Falha ao baixar (${r.status}).`, true);

  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  let n = 0;
  await fs.mkdir(dest, { recursive: true });
  for (const [rel, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.basename(rel) === "meta.json") continue; // metadado do acervo
    const abs = path.join(dest, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(await entry.async("nodebuffer")));
    n++;
  }
  return text(`Instalada "${slug}" (${n} arquivo(s)) em ${path.relative(process.cwd(), dest) || dest}`);
}

/* ============================ modo local ============================ */

const KIND_DIR = { skill: "skills", prompt: "prompts", doc: "docs" };

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function subdirs(dir) {
  try {
    const e = await fs.readdir(dir, { withFileTypes: true });
    return e.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}
async function scanLocal(kind) {
  const root = path.join(CONTENT_DIR, KIND_DIR[kind]);
  const out = [];
  for (const cat of await subdirs(root)) {
    for (const slug of await subdirs(path.join(root, cat))) {
      const meta = await readJson(path.join(root, cat, slug, "meta.json"));
      if (!meta) continue;
      out.push({
        kind, slug, category: cat, dir: path.join(root, cat, slug),
        name: typeof meta.name === "string" ? meta.name : slug,
        description: typeof meta.description === "string" ? meta.description : ""
      });
    }
  }
  return out;
}
async function allLocal() {
  const lists = await Promise.all(["skill", "prompt", "doc"].map(scanLocal));
  return lists.flat();
}
async function localTextFiles(dir) {
  const out = [];
  async function walk(absDir, rel) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === "" && e.name === "meta.json") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs, r);
        continue;
      }
      if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
      try {
        out.push({ path: r, text: await fs.readFile(abs, "utf8") });
      } catch {
        /* ignora */
      }
    }
  }
  await walk(dir, "");
  return out;
}
async function localListar() {
  const res = await allLocal();
  const fmt = (k) =>
    res.filter((r) => r.kind === k).map((r) => `  • ${r.slug} — ${r.name} (${r.category})`).join("\n");
  return text(
    `Acervo LOCAL (${res.length}) — ${CONTENT_DIR}\n\nSKILLS:\n${fmt("skill")}\n\nPROMPTS:\n${fmt("prompt")}\n\nDOCS:\n${fmt("doc")}`
  );
}
async function localBuscar(args) {
  const query = String(args?.query ?? "").trim();
  if (query.length < 2) return text("Busca precisa de ao menos 2 caracteres.", true);
  const q = fold(query);
  const hits = [];
  for (const r of await allLocal()) {
    const inMeta = fold(r.name).includes(q) || fold(r.description).includes(q);
    const files = await localTextFiles(r.dir);
    const matched = files.filter((f) => fold(f.text).includes(q)).map((f) => f.path).slice(0, 5);
    if (!inMeta && matched.length === 0) continue;
    hits.push(`• [${r.kind}] ${r.slug} — ${r.name}` + (matched.length ? `\n    arquivos: ${matched.join(", ")}` : ""));
  }
  return text(hits.length ? `${hits.length} resultado(s):\n\n${hits.join("\n")}` : `Nada para "${query}".`);
}
async function localInstalar(args) {
  const slug = String(args?.slug ?? "").trim();
  const force = args?.force === true;
  if (!SLUG_RE.test(slug)) return text(`Slug inválido: "${slug}".`, true);
  const found = (await scanLocal("skill")).find((s) => s.slug === slug);
  if (!found) return text(`Skill "${slug}" não encontrada.`, true);
  const dest = path.join(process.cwd(), ".claude", "skills", slug);
  try {
    if ((await fs.stat(dest)).isDirectory() && !force) {
      return text(`Já existe ${path.relative(process.cwd(), dest)}. Rode com force=true.`, true);
    }
  } catch {
    /* não existe */
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(found.dir, dest, {
    recursive: true, force: true,
    filter: (src) => path.basename(src) !== "meta.json"
  });
  return text(`Instalada "${found.name}" (${slug}) em ${path.relative(process.cwd(), dest) || dest}`);
}

/* ============================ server ============================ */

const baseTools = [
  { name: "acervo_listar", description: "Lista os recursos do acervo do workshop.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "acervo_buscar", description: "Busca full-text no ACERVO de skills/prompts/docs do aluno (nome, descrição e conteúdo dos arquivos). NÃO é a apostila do curso — para qualquer pergunta sobre a apostila/curso/aula/lição use acervo_curso.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "acervo_instalar", description: "Instala uma skill do acervo em .claude/skills/<slug>/.", inputSchema: { type: "object", properties: { slug: { type: "string" }, force: { type: "boolean" } }, required: ["slug"], additionalProperties: false } }
];
const loginTool = {
  name: "login",
  description: "Conecta este terminal à sua conta do portal (abre o browser pra autenticar). Use code=<código> como fallback.",
  inputSchema: { type: "object", properties: { code: { type: "string" } }, additionalProperties: false }
};
const lerTool = {
  name: "acervo_ler",
  description: "Lê/preview o texto de um arquivo do acervo SEM instalar. slug obrigatório; path opcional (default: arquivo principal).",
  inputSchema: { type: "object", properties: { slug: { type: "string" }, path: { type: "string" } }, required: ["slug"], additionalProperties: false }
};
const cursoTool = {
  name: "acervo_curso",
  description: "APOSTILA / MATERIAL DO CURSO do aluno (aulas, lições, o que foi ensinado no treinamento). Use SEMPRE esta tool — e não acervo_buscar — para QUALQUER pergunta sobre a apostila, o curso, uma aula, lição, módulo ou tema do treinamento. Sem args = índice das lições; query = busca no texto da apostila; lesson=<id> = texto completo de uma lição.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, lesson: { type: "string" } }, additionalProperties: false }
};
const whoamiTool = { name: "whoami", description: "Mostra com qual conta o terminal está conectado.", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const TOOLS = MODE === "http" ? [loginTool, whoamiTool, ...baseTools, lerTool, cursoTool] : baseTools;

const server = new Server({ name: "acervo-mcp", version: "0.2.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (MODE === "http") {
    switch (name) {
      case "login": return toolLogin(args);
      case "whoami": return httpWhoami();
      case "acervo_listar": return httpListar();
      case "acervo_buscar": return httpBuscar(args);
      case "acervo_ler": return httpLer(args);
      case "acervo_curso": return httpCurso(args);
      case "acervo_instalar": return httpInstalar(args);
    }
  } else {
    switch (name) {
      case "acervo_listar": return localListar();
      case "acervo_buscar": return localBuscar(args);
      case "acervo_instalar": return localInstalar(args);
    }
  }
  return text(`Tool desconhecida: ${name}`, true);
});

await server.connect(new StdioServerTransport());
console.error(`[acervo-mcp] pronto. modo=${MODE}${MODE === "http" ? ` portal=${PORTAL_URL}` : ` content=${CONTENT_DIR}`}`);
