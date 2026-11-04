import "dotenv/config";
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";

/* ───────────────────────────── config ───────────────────────────── */
const env = process.env;
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n));
};
const PORT = num(env.PORT, 1, 65535, 8080);
const API_TOKEN = env.API_TOKEN || "";
const BEDROCK_TOKEN = env.AWS_BEARER_TOKEN_BEDROCK || "";
const MODEL = env.AWS_BEDROCK_MODEL_ID || "";
const BEDROCK_REGION = env.AWS_BEDROCK_REGION || "us-east-1";
const BEDROCK_ENDPOINT = (env.AWS_BEDROCK_ENDPOINT || `https://bedrock-runtime.${BEDROCK_REGION}.amazonaws.com`).replace(/\/+$/, "");
const HEADLESS = env.HEADLESS !== "false";
const MAX_STEPS = num(env.MAX_STEPS, 5, 60, 30);
const PAGE_TEXT_LIMIT = num(env.PAGE_TEXT_LIMIT, 3000, 20000, 10000);
const STEP_TIMEOUT_MS = num(env.STEP_TIMEOUT_MS, 2000, 120000, 15000);       // сколько воспроизводимый шаг ждёт свой элемент
const LIVE_WAIT_MS = 2000;                                                   // то же, но когда действует LLM
const APPROVAL_TIMEOUT_MS = num(env.APPROVAL_TIMEOUT_MS, 10000, 86400000, 900000); // 15 мин
const TASK_TTL_MS = num(env.TASK_TTL_MS, 60000, 604800000, 3600000);         // сколько хранить завершённые задачи
const MAX_TASKS = num(env.MAX_TASKS, 20, 2000, 200);
const CONTEXT_KEEP_FULL = 3;                                                 // сколько последних результатов инструментов держим целиком
const MEMORY_FILE = path.resolve(env.MEMORY_FILE || "data/memory.json");
const WORKFLOWS_FILE = path.resolve(env.WORKFLOWS_FILE || path.join(path.dirname(MEMORY_FILE), "workflows.json"));
const FAILURES_DIR = path.join(path.dirname(MEMORY_FILE), "failures");
const PROFILE_DIR = path.resolve(env.BROWSER_PROFILE_DIR || "browser-profile");

if (!BEDROCK_TOKEN) throw new Error("Не задан AWS_BEARER_TOKEN_BEDROCK в .env");
if (!MODEL) throw new Error("Не задан AWS_BEDROCK_MODEL_ID в .env");
if (API_TOKEN.length < 24) throw new Error("Задайте API_TOKEN длиной не менее 24 символов в .env");

/* ───────────────────────────── patterns ───────────────────────────── */
const sensitiveField = /(password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|bank.?account|парол|номер карты|код карты)/i;
const secretText = /(api[_ -]?key|bearer\s|password|пароль|токен|cvv|одноразовый код)/i;
// \b только слева: «pay» ловит payment/paypal, но не «display»/«company»
const finalAction = /(\b(pay|purchase|buy now|place order|confirm booking|book now|reserve now|submit|create account|register|sign up|checkout)|заказать|оплатить|оплата|купить|оформить|подтвердить|забронировать|регистрац|отправить|создать аккаунт)/i;
const humanCheckText = /(captcha|verify you are human|checking your browser|turnstile|security check|two.factor|two factor|2fa|one.time password|verification code|подтвердите, что вы человек|проверка безопасности|введите код подтверждения)/i;

const instructions = `Ты — браузерный помощник, работающий через API. Выполняй задачу пошагово через инструменты.

Память: используй memory_search для поиска предпочтений и контекста. Сохраняй только долгосрочные полезные факты; никогда не сохраняй пароли, токены, платёжные данные и одноразовые коды.

Если страница показывает CAPTCHA, Cloudflare, 2FA, запрос входа или другую проверку человека — вызови request_human_action с краткой причиной. Не говори, что проверка пройдена, пока пользователь не подтвердил это.

Не обходи CAPTCHA, проверки личности, ограничения доступа и антибот-защиту. Не заполняй пароли и платёжные поля.

Перед отправкой формы, регистрацией, бронированием, заказом или оплатой нажми кнопку через click_text — система сама запросит отдельное подтверждение; до этого сообщи видимые детали.

Предпочитай click_text/fill_field по видимому тексту/подписи, а не по index: так действия можно надёжно записать и повторить. Не выдумывай цены, наличие, результаты и URL. После важных действий проверь результат. Используй только сайты и аккаунты, к которым пользователь имеет право доступа.`;

/* ───────────────────────────── state ───────────────────────────── */
const tasks = new Map();
let memory = [];
let workflows = {};
let browserContext;
let page;
let queue = Promise.resolve();
let shuttingDown = false;

const ok = msg => ({ ok: true, msg });
const fail = (msg, extra = {}) => ({ ok: false, msg, ...extra });
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ───────────────────────────── storage ───────────────────────────── */
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file); // атомарно: падение посреди записи не портит файл
}
async function loadData() {
  memory = await readJson(MEMORY_FILE, []);
  if (!Array.isArray(memory)) memory = [];
  workflows = await readJson(WORKFLOWS_FILE, {});
  if (!workflows || Array.isArray(workflows) || typeof workflows !== "object") workflows = {};
}
const saveMemory = () => writeJson(MEMORY_FILE, memory);
const saveWorkflows = () => writeJson(WORKFLOWS_FILE, workflows);

function findMemory(query = "") {
  const q = String(query).toLowerCase().trim();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  return memory
    .map(item => ({ item, score: words.reduce((n, w) => n + ((item.text + " " + (item.tags || []).join(" ")).toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter(x => !q || x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)))
    .slice(0, 8).map(x => x.item);
}

/* ───────────────────────────── tasks ───────────────────────────── */
function update(t, patch) { Object.assign(t, patch, { updatedAt: now() }); }
function log(t, message) { t.logs.push({ at: now(), message: String(message).slice(0, 3000) }); if (t.logs.length > 150) t.logs.shift(); }
const isFinal = s => ["completed", "failed", "cancelled"].includes(s);

function publicTask(t) {
  return {
    id: t.id, kind: t.kind, status: t.status, prompt: t.prompt, workflow: t.workflow ?? undefined,
    progress: t.progress ?? undefined, createdAt: t.createdAt, updatedAt: t.updatedAt,
    result: t.result ?? null, error: t.error ?? null, currentUrl: page && !page.isClosed() ? page.url() : null,
    approval: t.status === "awaiting_confirmation" ? t.approval : undefined, logs: t.logs
  };
}

function pruneTasks() {
  const cutoff = Date.now() - TASK_TTL_MS;
  for (const [id, t] of tasks) if (isFinal(t.status) && Date.parse(t.updatedAt) < cutoff) tasks.delete(id);
  if (tasks.size > MAX_TASKS) {
    for (const [id, t] of tasks) { if (tasks.size <= MAX_TASKS) break; if (isFinal(t.status)) tasks.delete(id); }
  }
}

function createTask(kind, fields) {
  pruneTasks();
  const t = { id: randomUUID(), kind, status: "queued", createdAt: now(), updatedAt: now(), logs: [], approval: null, result: null, error: null, ...fields };
  tasks.set(t.id, t);
  return t;
}

function enqueue(t, runner) {
  const run = queue.then(async () => { if (!t.cancelled) await runner(t); });
  queue = run.catch(() => {});
}

// Ожидание подтверждения через API. Автоотклонение по таймауту — чтобы очередь не зависала навсегда.
function waitApproval(task, details) {
  update(task, { status: "awaiting_confirmation", approval: { ...details, required: true, expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString() } });
  log(task, `Ожидает подтверждения: ${details.label || details.reason || "действие"} на ${details.url || ""}`);
  return new Promise(resolve => {
    const done = v => { clearTimeout(timer); task.resolveApproval = null; resolve(v); };
    const timer = setTimeout(() => { if (task.resolveApproval === done) { log(task, "Подтверждение не получено вовремя — действие отклонено."); done(false); } }, APPROVAL_TIMEOUT_MS);
    task.resolveApproval = done;
  }).then(v => {
    if (task.status === "awaiting_confirmation") update(task, { status: "running", approval: null });
    return v;
  });
}

/* ───────────────────────────── browser helpers ───────────────────────────── */
async function getPage() {
  if (!page || page.isClosed()) page = browserContext.pages().filter(p => !p.isClosed()).at(-1) || await browserContext.newPage();
  return page;
}

// Ждём, пока страница «устаканится»: DOMContentLoaded + отсутствие мутаций DOM ~350мс (но не дольше maxMs).
async function settle(p, maxMs = 4000, quietMs = 350) {
  try { await p.waitForLoadState("domcontentloaded", { timeout: maxMs }); } catch {}
  try {
    await p.evaluate(([cap, quiet]) => new Promise(resolve => {
      let timer, capTimer;
      const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, quiet); });
      const finish = () => { obs.disconnect(); clearTimeout(timer); clearTimeout(capTimer); resolve(); };
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, quiet); capTimer = setTimeout(finish, cap);
    }), [maxMs, quietMs]);
  } catch {} // навигация посреди evaluate — нормально
}

// Опрашиваем кандидатов до таймаута: решает гонки с SPA/ленивым рендером.
async function findVisible(candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const make of candidates) {
      try { const loc = make(); if (await loc.count() && await loc.isVisible()) return loc; } catch {}
    }
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

async function detectHumanCheck(p) {
  try {
    if (p.frames().some(f => /captcha|turnstile|challenge-platform|hcaptcha/i.test(f.url()))) return true;
    const text = await p.evaluate(() => (document.body?.innerText || "").slice(0, 6000));
    return humanCheckText.test(text);
  } catch { return false; }
}

async function visibleControls(p) {
  return p.evaluate(() => {
    const clean = s => String(s || "").replace(/\s+/g, " ").trim();
    // чистим старые метки: иначе скрытые элементы хранят устаревшие индексы и селектор находит дубликаты
    document.querySelectorAll("[data-agent-idx]").forEach(el => el.removeAttribute("data-agent-idx"));
    const all = [...document.querySelectorAll("input,textarea,select,button,a,[role=button]")];
    const visible = all.filter(el => {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      return el.isConnected && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0 && r.width > 0 && r.height > 0 && el.getAttribute("aria-hidden") !== "true";
    });
    visible.forEach((el, i) => el.setAttribute("data-agent-idx", String(i)));
    return visible.slice(0, 150).map((el, index) => ({
      index, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "",
      text: clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.getAttribute("name")).slice(0, 160),
      label: clean(el.labels?.[0]?.innerText).slice(0, 80), name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "", ariaLabel: el.getAttribute("aria-label") || "", disabled: Boolean(el.disabled)
    }));
  });
}

/* ───────────────────────────── recording ───────────────────────────── */
function recordStep(task, tool, args, urlBefore, urlAfter, extra = {}) {
  if (!task?.recordedSteps) return;
  task.recordedSteps.push({ tool, args, urlBefore, urlAfter, ...extra });
}

// Подставляем {{ключ}} вместо значений параметров. Точное совпадение — для любой длины,
// подстрока — только для значений ≥4 символов (иначе «1» испортит все URL).
function templateValue(value, params) {
  const entries = Object.entries(params || {}).map(([k, v]) => [k, String(v)]).filter(([, v]) => v).sort((a, b) => b[1].length - a[1].length);
  const sub = v => {
    if (typeof v === "string") {
      for (const [k, pv] of entries) if (v === pv) return `{{${k}}}`;
      let out = v;
      for (const [k, pv] of entries) if (pv.length >= 4 && out.includes(pv)) out = out.split(pv).join(`{{${k}}}`);
      return out;
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(value);
}

function placeholders(steps) { return [...new Set([...JSON.stringify(steps).matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))]; }

function interpolate(value, params) {
  if (typeof value === "string") return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    if (params?.[key] === undefined) throw new Error(`Не передан параметр «${key}»`);
    return String(params[key]);
  });
  if (Array.isArray(value)) return value.map(v => interpolate(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, params)]));
  return value;
}

async function saveWorkflow(t) {
  const name = t.saveAsWorkflow;
  if (!name || !t.recordedSteps.length) return null;
  const params = t.params || {};
  const steps = t.recordedSteps.map(s => ({ tool: s.tool, args: templateValue(s.args, params), ...(s.approval ? { approval: true } : {}), urlBefore: s.urlBefore, urlAfter: s.urlAfter }));
  workflows[name] = { name, description: t.prompt.slice(0, 500), createdAt: workflows[name]?.createdAt || now(), updatedAt: now(), params, steps };
  await saveWorkflows();
  return { name, stepCount: steps.length, approvalSteps: steps.filter(s => s.approval).length, parameters: placeholders(steps) };
}

/* ───────────────────────────── tools ───────────────────────────── */
async function openUrl({ url }) {
  let u; try { u = new URL(url); } catch { return fail("Нужен полный URL, например https://example.com"); }
  if (!["http:", "https:"].includes(u.protocol)) return fail("Разрешены только http и https.");
  const p = await getPage(); const before = p.url();
  try { await p.goto(u.href, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch (e) { return fail(`Не удалось открыть страницу: ${e.message}`); }
  await settle(p, 3000);
  return { ...ok(`Открыта страница: ${p.url()}\nЗаголовок: ${await p.title()}`), record: ["open_url", { url: u.href }, before, p.url()] };
}

async function readPage() {
  const p = await getPage();
  const controls = await visibleControls(p);
  const data = await p.evaluate(LIMIT => ({ url: location.href, title: document.title, text: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, LIMIT) }), PAGE_TEXT_LIMIT);
  const snapshot = JSON.stringify({ ...data, controls }, null, 2);
  return ok((await detectHumanCheck(p))
    ? `${snapshot}\n\nВНИМАНИЕ: возможна CAPTCHA/проверка/авторизация. Не пытайся её обходить; вызови request_human_action.`
    : snapshot);
}

async function fillField(args, task, { wait = LIVE_WAIT_MS } = {}) {
  const field = String(args.field ?? "").trim(); const value = String(args.value ?? "");
  const byIndex = Number.isInteger(args.index);
  if (!byIndex && !field) return fail("Укажи field или index.");
  if (sensitiveField.test(field)) return fail("Для безопасности не заполняю пароли и платёжные реквизиты. Введи их вручную в браузере; не отправляй их в API.");
  const p = await getPage(); const before = p.url();
  const esc = field.replace(/["\\]/g, "\\$&");
  const candidates = byIndex
    ? [() => p.locator(`[data-agent-idx="${args.index}"]`).first()]
    : [() => p.getByLabel(field, { exact: false }).first(), () => p.getByPlaceholder(field, { exact: false }).first(),
       () => p.locator(`[name="${esc}"]`).first(), () => p.getByRole("textbox", { name: field, exact: false }).first()];
  const loc = await findVisible(candidates, wait);
  if (!loc) return fail(`Не нашёл видимое поле «${field || "#" + args.index}» (ждал ${wait} мс). Сначала вызови read_page.`);
  try {
    const meta = await loc.evaluate(el => ({
      type: (el.getAttribute("type") || "").toLowerCase(), name: el.getAttribute("name") || "", placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "", label: (el.labels?.[0]?.innerText || "").replace(/\s+/g, " ").trim()
    }));
    if (sensitiveField.test([meta.type, meta.name, meta.placeholder, meta.label, meta.ariaLabel].join(" "))) return fail("Для безопасности не заполняю парольные и платёжные поля.");
    await loc.fill(value, { timeout: 5000 });
    // Записываем СТАБИЛЬНЫЙ дескриптор (подпись/placeholder/name), а не index, который зависит от порядка DOM.
    const handle = field || meta.label || meta.ariaLabel || meta.placeholder || meta.name;
    recordStep(task, "fill_field", handle ? { field: handle, value } : { index: args.index, value }, before, p.url());
    return ok(`Поле «${handle || "#" + args.index}» заполнено.`);
  } catch (e) { return fail(`Не удалось заполнить поле: ${e.message}`); }
}

async function clickText(args, task, { wait = LIVE_WAIT_MS, forceApproval = false } = {}) {
  const text = String(args.text ?? "").trim(); const byIndex = Number.isInteger(args.index);
  if (!byIndex && !text) return fail("Укажи text или index.");
  const p = await getPage(); const before = p.url();
  const candidates = byIndex
    ? [() => p.locator(`[data-agent-idx="${args.index}"]`).first()]
    : [() => p.getByRole("button", { name: text, exact: false }).first(), () => p.getByRole("link", { name: text, exact: false }).first(), () => p.getByText(text, { exact: false }).first()];
  const loc = await findVisible(candidates, wait);
  if (!loc) return fail(`Не найден видимый элемент «${text || "#" + args.index}» (ждал ${wait} мс). Повтори read_page.`);
  try {
    const meta = await loc.evaluate(el => {
      const c = el.closest('button,input[type="submit"],input[type="button"],a,[role="button"]') || el;
      return { label: String(c.innerText || c.getAttribute("aria-label") || c.value || "").replace(/\s+/g, " ").trim(), type: (c.getAttribute("type") || "").toLowerCase(), tag: c.tagName.toLowerCase(), inForm: Boolean(c.closest("form")), href: c.href || "" };
    });
    const label = meta.label || text || `#${args.index}`;
    const needsApproval = forceApproval || meta.type === "submit" || (meta.inForm && ["button", "input"].includes(meta.tag)) || finalAction.test(`${text} ${label}`);
    if (needsApproval) {
      const approved = await waitApproval(task, { type: "final_action", label, url: p.url(), href: meta.href || null, actionText: text || label, notice: "Подтверждение разрешает одно нажатие. Проверь сайт, действие, сумму и детали перед подтверждением." });
      if (!approved) return fail("Пользователь отклонил действие. Ничего не нажато.", { rejected: true });
    }
    await loc.click({ timeout: 8000 });
    await settle(p);
    const cur = await getPage(); // клик мог открыть новую вкладку — context.on("page") уже переключил page
    recordStep(task, "click_text", { text: (text || label).slice(0, 120) }, before, cur.url(), needsApproval ? { approval: true } : {});
    return ok(`Нажат элемент «${label}». Текущий URL: ${cur.url()}`);
  } catch (e) { return fail(`Не удалось нажать «${text || "#" + args.index}»: ${e.message}`); }
}

async function requestHumanAction(task, { reason, actionRequired }) {
  const p = await getPage();
  const approved = await waitApproval(task, { type: "human_intervention", label: reason, reason, actionRequired, url: p.url(), notice: "Откройте браузерную сессию (noVNC), выполните действие вручную, затем вызовите POST /tasks/:id/confirm. Не отправляйте пароль или одноразовый код в API." });
  return approved ? ok("Пользователь подтвердил ручное действие. Продолжай с текущей страницы и проверь состояние.") : fail("Пользователь отклонил ручное вмешательство. Останови задачу.", { rejected: true });
}

function toolDefs() {
  const fn = (name, description, properties, required = []) => ({ name, description, parameters: { type: "object", properties, required, additionalProperties: false } });
  return [
    fn("open_url", "Открыть страницу по полному HTTP/HTTPS URL", { url: { type: "string" } }, ["url"]),
    fn("read_page", "Прочитать текст страницы и видимые элементы управления; при CAPTCHA или входе запроси ручное вмешательство", {}),
    fn("click_text", "Нажать видимую кнопку/ссылку по тексту (предпочтительно) или индексу из read_page. Для финальных действий требуется подтверждение API", { text: { type: "string" }, index: { type: "integer", minimum: 0 } }),
    fn("fill_field", "Заполнить обычное видимое поле по подписи/placeholder/name (предпочтительно) или индексу из read_page. Не заполнять пароли и платёжные реквизиты", { field: { type: "string" }, index: { type: "integer", minimum: 0 }, value: { type: "string" } }, ["value"]),
    fn("memory_search", "Найти подходящие записи в постоянной памяти", { query: { type: "string" } }, ["query"]),
    fn("memory_save", "Сохранить безопасный долгосрочный факт или предпочтение", { text: { type: "string" }, tags: { type: "array", items: { type: "string" }, maxItems: 10 } }, ["text"]),
    fn("request_human_action", "Поставить задачу на паузу, чтобы человек вручную прошёл CAPTCHA/Cloudflare, 2FA или авторизацию. После ручного действия пользователь вызовет POST /tasks/:id/confirm", { reason: { type: "string" }, actionRequired: { type: "string" } }, ["reason", "actionRequired"])
  ];
}
const bedrockToolConfig = { tools: toolDefs().map(f => ({ toolSpec: { name: f.name, description: f.description, inputSchema: { json: f.parameters } } })), toolChoice: { auto: {} } };

async function runTool(t, name, args) {
  switch (name) {
    case "open_url": { const r = await openUrl(args); if (r.record) recordStep(t, ...r.record); return r; }
    case "read_page": return readPage();
    case "fill_field": return fillField(args, t);
    case "click_text": return clickText(args, t);
    case "request_human_action": return requestHumanAction(t, args);
    case "memory_search": return ok(JSON.stringify(findMemory(args.query || "")));
    case "memory_save": {
      const value = String(args.text || "").trim().slice(0, 1000);
      if (!value) return fail("Пустую запись сохранить нельзя.");
      if (sensitiveField.test(value) || secretText.test(value)) return fail("Похоже, запись содержит секретные данные; не сохраняю.");
      const tags = Array.isArray(args.tags) ? args.tags.slice(0, 10) : [];
      const existing = memory.find(x => x.text.toLowerCase() === value.toLowerCase());
      if (existing) { existing.updatedAt = now(); if (tags.length) existing.tags = tags; }
      else memory.push({ id: randomUUID(), text: value, tags, createdAt: now(), updatedAt: now() });
      memory = memory.slice(-500); await saveMemory();
      return ok("Запись сохранена в постоянную память.");
    }
    default: return fail("Неизвестный инструмент.");
  }
}

/* ───────────────────────────── LLM (Bedrock Converse) ───────────────────────────── */
async function callBedrock(messages, systemPrompt) {
  const response = await fetch(`${BEDROCK_ENDPOINT}/model/${encodeURIComponent(MODEL)}/converse`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEDROCK_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ system: [{ text: systemPrompt }], messages, toolConfig: bedrockToolConfig, inferenceConfig: { maxTokens: 4096, temperature: 0.2 } }),
    signal: AbortSignal.timeout(120_000)
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { throw new Error(`Bedrock вернул не JSON (HTTP ${response.status}): ${raw.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`Bedrock HTTP ${response.status}: ${data.message || data.messageText || JSON.stringify(data).slice(0, 1000)}`);
  if (!data.output?.message) throw new Error(`В ответе Bedrock нет сообщения: ${JSON.stringify(data).slice(0, 1000)}`);
  return data;
}

// Контекст растёт на каждом шаге (read_page = до 10 КБ). Старые результаты инструментов сжимаем.
function trimContext(messages) {
  const idxs = messages.flatMap((m, i) => m.role === "user" && m.content?.some?.(b => b.toolResult) ? [i] : []);
  for (const i of idxs.slice(0, -CONTEXT_KEEP_FULL))
    for (const b of messages[i].content) for (const c of b.toolResult?.content || [])
      if (typeof c.text === "string" && c.text.length > 400) c.text = c.text.slice(0, 300) + " …[обрезано; вызови read_page заново, если нужно]";
}

async function runAgent(t) {
  update(t, { status: "running" });
  log(t, "Задача запущена через Amazon Bedrock Converse");
  const systemPrompt = `${instructions}\n\nСохранённая память (может быть неполной; ищи дополнительно через memory_search):\n${JSON.stringify(findMemory(t.prompt).slice(0, 5))}`;
  const messages = [{ role: "user", content: [{ text: t.prompt }] }];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (t.cancelled) return update(t, { status: "cancelled", result: "Задача отменена." });
      trimContext(messages);
      const response = await callBedrock(messages, systemPrompt);
      const msg = response.output.message; messages.push(msg);
      const calls = (msg.content || []).filter(b => b.toolUse);
      if (!calls.length) {
        const answer = (msg.content || []).filter(b => typeof b.text === "string").map(b => b.text).join("\n").trim();
        update(t, { status: "completed", result: answer || "Задача завершена." });
        log(t, "Задача завершена");
        if (t.saveAsWorkflow) {
          const wf = await saveWorkflow(t);
          if (wf) { t.workflowSaved = wf; log(t, `Workflow сохранён: ${wf.name} (${wf.stepCount} шагов, шагов с подтверждением: ${wf.approvalSteps}, параметры: ${wf.parameters.join(", ") || "—"})`); }
          else log(t, "Workflow не сохранён: не было записанных действий.");
        }
        return;
      }
      const results = [];
      for (const { toolUse: call } of calls) {
        log(t, `Инструмент: ${call.name}`);
        let r; try { r = await runTool(t, call.name, call.input || {}); } catch (e) { r = fail(`Ошибка инструмента: ${e.message}`); }
        const text = String(r.msg).slice(0, 10000);
        log(t, text.slice(0, 1500));
        results.push({ toolResult: { toolUseId: call.toolUseId, content: [{ text }] } });
        if (t.cancelled) return update(t, { status: "cancelled", result: "Задача отменена." });
      }
      messages.push({ role: "user", content: results });
    }
    update(t, { status: "failed", error: `Достигнут лимит ${MAX_STEPS} шагов без завершения.` });
  } catch (e) { update(t, { status: "failed", error: e.message }); log(t, `Ошибка: ${e.message}`); }
}

/* ───────────────────────────── workflow replay ───────────────────────────── */
const execStep = (t, step, args) => {
  switch (step.tool) {
    case "open_url": return openUrl(args);
    case "fill_field": return fillField(args, null, { wait: STEP_TIMEOUT_MS });
    case "click_text": return clickText(args, t, { wait: STEP_TIMEOUT_MS, forceApproval: Boolean(step.approval) });
    default: return Promise.resolve(fail(`Неподдерживаемый шаг: ${step.tool}`));
  }
};
const redact = (tool, args) => tool === "fill_field" ? { ...args, value: `***(${String(args.value ?? "").length} симв.)` } : args;

async function runWorkflow(t) {
  update(t, { status: "running" });
  const wf = workflows[t.workflow];
  const total = wf.steps.length;
  const params = { ...(wf.params || {}), ...(t.params || {}) };
  let i = 0;
  try {
    for (; i < total; i++) {
      if (t.cancelled) return update(t, { status: "cancelled", result: "Задача отменена." });
      const step = wf.steps[i];
      const args = interpolate(step.args, params);
      update(t, { progress: { step: i + 1, total } });
      log(t, `Шаг ${i + 1}/${total}: ${step.tool} ${JSON.stringify(redact(step.tool, args))}${step.approval ? " [требует подтверждения]" : ""}`);
      let r = await execStep(t, step, args);
      if (!r.ok && !r.rejected && await detectHumanCheck(await getPage())) {
        // сайт показал проверку «вы человек» — не обходим, просим человека и повторяем шаг один раз
        const done = await requestHumanAction(t, { reason: "Сайт запросил проверку. Пройдите её вручную", actionRequired: "Выполните проверку в браузере (noVNC), затем подтвердите" });
        if (done.ok) r = await execStep(t, step, args);
        else r = done;
      }
      if (r.rejected) { if (!t.cancelled) update(t, { status: "cancelled", result: `Остановлено пользователем на шаге ${i + 1}/${total}.` }); return; }
      if (!r.ok) throw new Error(`Шаг ${i + 1}/${total} (${step.tool}): ${r.msg}`);
      log(t, r.msg.slice(0, 300));
    }
    update(t, { status: "completed", result: { workflow: t.workflow, stepsExecuted: total, finalUrl: (await getPage()).url() } });
  } catch (e) {
    let shot = "";
    try { await fs.mkdir(FAILURES_DIR, { recursive: true }); shot = path.join(FAILURES_DIR, `${t.id}.png`); await (await getPage()).screenshot({ path: shot }); log(t, `Скриншот: ${shot}`); } catch { shot = ""; }
    update(t, { status: "failed", error: e.message, failedStep: i + 1 });
    log(t, `Ошибка: ${e.message}`);
  }
}

/* ───────────────────────────── HTTP ───────────────────────────── */
function send(res, status, obj) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj, null, 2)); }
function authorized(req) {
  const h = req.headers.authorization || ""; const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || token.length !== API_TOKEN.length) return false;
  try { return timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN)); } catch { return false; }
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 100_000) throw new HttpError(413, "Тело запроса слишком большое (лимит 100 КБ)"); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Некорректный JSON"); }
}
const nameOk = n => typeof n === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(n);
const paramsOf = b => {
  if (b.params === undefined) return {};
  if (!b.params || typeof b.params !== "object" || Array.isArray(b.params)) throw new HttpError(400, "params должен быть объектом");
  return b.params;
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") {
      const alive = Boolean(page && !page.isClosed());
      return send(res, alive ? 200 : 503, { ok: alive, service: "ai-browser-agent-api", browser: alive ? "up" : "down", rssMb: Math.round(process.memoryUsage().rss / 1048576), tasks: tasks.size });
    }
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized", message: "Передайте Authorization: Bearer <API_TOKEN>" });

    if (url.pathname === "/" && req.method === "GET")
      return send(res, 200, { service: "ai-browser-agent-api", model: MODEL, endpoints: ["POST /tasks", "GET /tasks", "GET /tasks/:id", "POST /tasks/:id/confirm", "POST /tasks/:id/reject", "POST /tasks/:id/cancel", "GET /memory", "POST /memory", "GET /workflows", "GET /workflows/:name", "DELETE /workflows/:name", "POST /workflows/:name/run"] });

    if (url.pathname === "/memory" && req.method === "GET") return send(res, 200, { count: memory.length, memory });
    if (url.pathname === "/memory" && req.method === "POST") {
      const b = await body(req); const value = String(b.text || "").trim().slice(0, 1000);
      if (!value) throw new HttpError(400, "Поле text обязательно");
      if (sensitiveField.test(value) || secretText.test(value)) throw new HttpError(400, "Не сохраняйте секреты или платёжные данные");
      memory.push({ id: randomUUID(), text: value, tags: Array.isArray(b.tags) ? b.tags.slice(0, 10) : [], createdAt: now(), updatedAt: now() });
      memory = memory.slice(-500); await saveMemory();
      return send(res, 201, { ok: true, count: memory.length });
    }

    /* workflows */
    if (url.pathname === "/workflows" && req.method === "GET")
      return send(res, 200, { count: Object.keys(workflows).length, workflows: Object.values(workflows).map(w => ({ name: w.name, description: w.description, createdAt: w.createdAt, updatedAt: w.updatedAt, parameters: placeholders(w.steps), defaults: w.params, stepCount: w.steps.length, approvalSteps: w.steps.filter(s => s.approval).length })) });
    const wf = url.pathname.match(/^\/workflows\/([^/]+)(\/run)?$/);
    if (wf) {
      const name = decodeURIComponent(wf[1]);
      if (!workflows[name]) throw new HttpError(404, `Workflow «${name}» не найден`);
      if (!wf[2] && req.method === "GET") return send(res, 200, { workflow: workflows[name] });
      if (!wf[2] && req.method === "DELETE") { delete workflows[name]; await saveWorkflows(); return send(res, 200, { ok: true, deleted: name }); }
      if (wf[2] && req.method === "POST") {
        const params = paramsOf(await body(req));
        const missing = placeholders(workflows[name].steps).filter(k => params[k] === undefined && workflows[name].params?.[k] === undefined);
        if (missing.length) throw new HttpError(400, `Не переданы параметры: ${missing.join(", ")}`);
        const t = createTask("workflow", { prompt: `workflow:${name}`, workflow: name, params });
        enqueue(t, runWorkflow);
        return send(res, 202, { task: publicTask(t), poll: `GET /tasks/${t.id}` });
      }
    }

    /* tasks */
    if (url.pathname === "/tasks" && req.method === "GET")
      return send(res, 200, { count: tasks.size, tasks: [...tasks.values()].slice(-50).map(t => ({ id: t.id, kind: t.kind, status: t.status, prompt: t.prompt.slice(0, 120), progress: t.progress, updatedAt: t.updatedAt })) });
    if (url.pathname === "/tasks" && req.method === "POST") {
      const b = await body(req);
      if (typeof b.prompt !== "string" || !b.prompt.trim()) throw new HttpError(400, "Поле prompt обязательно и должно быть строкой");
      if (b.saveAsWorkflow !== undefined && !nameOk(b.saveAsWorkflow)) throw new HttpError(400, "saveAsWorkflow должен содержать 1–80 символов: латиница, цифры, _ или -");
      const t = createTask("agent", { prompt: b.prompt.trim().slice(0, 10000), recordedSteps: [], saveAsWorkflow: b.saveAsWorkflow || null, params: paramsOf(b) });
      enqueue(t, runAgent);
      return send(res, 202, { task: publicTask(t), poll: `GET /tasks/${t.id}` });
    }
    const m = url.pathname.match(/^\/tasks\/([0-9a-f-]+)(?:\/(confirm|reject|cancel))?$/i);
    if (m) {
      const t = tasks.get(m[1]); if (!t) throw new HttpError(404, "Task not found");
      const action = m[2];
      if (req.method === "GET" && !action) return send(res, 200, { task: publicTask(t), workflow: t.workflowSaved || null });
      if (req.method === "POST" && (action === "confirm" || action === "reject")) {
        if (t.status !== "awaiting_confirmation" || !t.resolveApproval) throw new HttpError(409, "Эта задача сейчас не ожидает подтверждения");
        t.resolveApproval(action === "confirm");
        return send(res, 200, { ok: true, message: action === "confirm" ? "Подтверждение принято; агент продолжит выполнение." : "Действие отклонено." });
      }
      if (req.method === "POST" && action === "cancel") {
        if (isFinal(t.status)) throw new HttpError(409, `Задача уже завершена (${t.status})`);
        t.cancelled = true; t.resolveApproval?.(false);
        update(t, { status: "cancelled", result: "Задача отменена." });
        return send(res, 200, { ok: true, task: publicTask(t) });
      }
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error("Unhandled API error:", e);
    return send(res, 500, { error: "Internal error", message: e.message });
  }
});

/* ───────────────────────────── startup ───────────────────────────── */
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));

await loadData();
// После падения/пересоздания контейнера Chromium оставляет lock-файлы профиля и отказывается стартовать
for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) await fs.rm(path.join(PROFILE_DIR, f), { force: true }).catch(() => {});

browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS, viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", ...(HEADLESS ? [] : ["--window-position=0,0", "--window-size=1440,900"])]
});
page = browserContext.pages()[0] || await browserContext.newPage();
// Клик с target=_blank открывает вкладку — агент должен переключаться на неё и не копить старые
browserContext.on("page", p => { page = p; });
// Chromium упал (например, OOM) — выходим, чтобы Docker (restart: unless-stopped) поднял всё заново, а не держал «живое» API с мёртвым браузером
browserContext.on("close", () => { if (shuttingDown) return; console.error("Browser context closed — exiting for restart"); process.exit(1); });

server.listen(PORT, "0.0.0.0", () => console.log(`AI Browser Agent API слушает порт ${PORT}; model=${MODEL}; headless=${HEADLESS}`));

async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  server.close();
  await Promise.race([browserContext?.close().catch(() => {}), sleep(5000)]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
