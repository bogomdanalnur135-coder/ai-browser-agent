import "dotenv/config";
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = process.env.API_TOKEN || "";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL =
  process.env.AWS_BEDROCK_MODEL_ID ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1";
const HEADLESS = process.env.HEADLESS !== "false";
const MEMORY_FILE = path.resolve(process.env.MEMORY_FILE || "data/memory.json");
const MAX_STEPS = Math.max(
  5,
  Math.min(60, Number(process.env.MAX_STEPS || 30))
);

const WORKFLOWS_FILE = path.resolve(
  process.env.WORKFLOWS_FILE || "data/workflows.json"
);

const PAGE_TEXT_LIMIT = Math.max(
  3000,
  Math.min(20000, Number(process.env.PAGE_TEXT_LIMIT || 10000))
);
if (!API_KEY) throw new Error("Не задан OPENAI_API_KEY в .env");
if (API_TOKEN.length < 24) throw new Error("Задайте API_TOKEN длиной не менее 24 символов в .env");

const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || "us-east-1";

async function callBedrock(messages, systemPrompt) {
  const endpoint =
    `https://bedrock-runtime.${BEDROCK_REGION}.amazonaws.com/model/${MODEL}/converse`;

  const toolConfig = {
    tools: toolsFor().map(({ function: f }) => ({
      toolSpec: {
        name: f.name,
        description: f.description,
        inputSchema: { json: f.parameters }
      }
    })),
    toolChoice: { auto: {} }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      system: [{ text: systemPrompt }],
      messages,
      toolConfig,
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.2
      }
    })
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Bedrock вернул не JSON (HTTP ${response.status}): ${raw.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Bedrock HTTP ${response.status}: ${
        data.message || data.messageText || JSON.stringify(data).slice(0, 1000)
      }`
    );
  }

  if (!data.output?.message) {
    throw new Error(`В ответе Bedrock нет сообщения: ${JSON.stringify(data).slice(0, 1000)}`);
  }

  return data;
}

const tasks = new Map();
let memory = [];
let workflows = {};
let browserContext;
let page;
let queue = Promise.resolve();

const sensitiveField = /(password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|bank.?account|парол|номер карты|код карты)/i;
const finalAction = /(pay|payment|purchase|buy now|place order|confirm booking|book now|reserve now|submit|create account|register|sign up|checkout|заказать|оплатить|оплата|купить|оформить|подтвердить|забронировать|регистрац|отправить|создать аккаунт)/i;
const humanCheck = /(captcha|verify you are human|checking your browser|cloudflare|turnstile|security check|two.factor|two factor|2fa|one.time password|verification code|подтвердите, что вы человек|проверка безопасности|введите код подтверждения)/i;
const instructions = `Ты — браузерный помощник, работающий через API. Выполняй задачу пошагово через инструменты.
Память: используй memory_search для поиска предпочтений и контекста. Сохраняй только долгосрочные полезные факты; никогда не сохраняй пароли, токены, платёжные данные и одноразовые коды.
Если страница показывает CAPTCHA, Cloudflare, 2FA, запрос входа или другую проверку человека — вызови request_human_action с краткой причиной. Не говори, что проверка пройдена, пока пользователь не подтвердил это.
Не обходи CAPTCHA, проверки личности, ограничения доступа и антибот-защиту. Не заполняй пароли и платёжные поля.
Перед отправкой формы, регистрацией, бронированием, заказом или оплатой обязательно запроси отдельное подтверждение через click_text; сообщи видимые детали до подтверждения.
Не выдумывай цены, наличие, результаты и URL. После важных действий проверь результат. Используй только сайты и аккаунты, к которым пользователь имеет право доступа.`;

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }
async function loadData() { memory = await readJson(MEMORY_FILE, []); if (!Array.isArray(memory)) memory = []; workflows = await readJson(WORKFLOWS_FILE, {}); if (!workflows || Array.isArray(workflows) || typeof workflows !== "object") workflows = {}; }
async function saveMemory() { await writeJson(MEMORY_FILE, memory); }
async function saveWorkflows() { await writeJson(WORKFLOWS_FILE, workflows); }
function findMemory(query = "") { const q = String(query).toLowerCase().trim(); const words = q.split(/\s+/).filter(w => w.length > 2); return memory.map(item => ({ item, score: words.reduce((n, w) => n + ((item.text + " " + (item.tags || []).join(" ")).toLowerCase().includes(w) ? 1 : 0), 0) })).filter(x => !q || x.score > 0).sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt))).slice(0, 8).map(x => x.item); }
function update(task, patch) { Object.assign(task, patch, { updatedAt: new Date().toISOString() }); }
function log(task, message) { task.logs.push({ at: new Date().toISOString(), message: String(message).slice(0, 3000) }); if (task.logs.length > 100) task.logs.shift(); }
function publicTask(t) { return { id: t.id, status: t.status, prompt: t.prompt, createdAt: t.createdAt, updatedAt: t.updatedAt, result: t.result ?? null, error: t.error ?? null, currentUrl: page?.url?.() || null, approval: t.status === "awaiting_confirmation" ? t.approval : undefined, logs: t.logs }; }
function waitApproval(task, details) {
  update(task, { status: "awaiting_confirmation", approval: { ...details, required: true } });
  log(task, `Ожидает подтверждения: ${details.label || details.reason || "действие"} на ${details.url || page.url()}`);
  return new Promise(resolve => { task.resolveApproval = resolve; });
}

function toolsFor() {
  return [
    { type: "function", function: { name: "open_url", description: "Открыть страницу по полному HTTP/HTTPS URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
    { type: "function", function: { name: "read_page", description: "Прочитать текст страницы и видимые элементы управления; при CAPTCHA или входе сообщи об этом и запроси ручное вмешательство", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
    { type: "function", function: { name: "click_text", description: "Нажать видимую кнопку/ссылку по тексту или индексу из read_page. Для финальных действий требуется подтверждение API", parameters: { type: "object", properties: { text: { type: "string" }, index: { type: "integer", minimum: 0 } }, additionalProperties: false } } },
    { type: "function", function: { name: "fill_field", description: "Заполнить обычное видимое поле по подписи/placeholder/name или индексу из read_page. Не заполнять пароли и платёжные реквизиты", parameters: { type: "object", properties: { field: { type: "string" }, value: { type: "string" }, index: { type: "integer", minimum: 0 } }, required: ["value"], additionalProperties: false } } },
    { type: "function", function: { name: "memory_search", description: "Найти подходящие записи в постоянной памяти", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "memory_save", description: "Сохранить безопасный долгосрочный факт или предпочтение", parameters: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" }, maxItems: 10 } }, required: ["text"], additionalProperties: false } } },
    { type: "function", function: { name: "request_human_action", description: "Поставить задачу на паузу, чтобы человек вручную прошёл CAPTCHA/Cloudflare, 2FA или авторизацию. После ручного действия пользователь вызовет POST /tasks/:id/confirm", parameters: { type: "object", properties: { reason: { type: "string" }, actionRequired: { type: "string" } }, required: ["reason", "actionRequired"], additionalProperties: false } } }
  ];
}

function visibleSelector(index) { return `[data-agent-idx="${Number(index)}"]`; }
async function visibleControls() {
  return page.evaluate(() => {
    const clean = s => String(s || "").replace(/\s+/g, " ").trim();
    const all = [...document.querySelectorAll("input,textarea,select,button,a,[role=button]")];
    const visible = all.filter(el => {
      const style = getComputedStyle(el); const r = el.getBoundingClientRect();
      return el.isConnected && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0 && r.width > 0 && r.height > 0 && el.getAttribute("aria-hidden") !== "true";
    });
    visible.forEach((el, i) => el.setAttribute("data-agent-idx", String(i)));
    return visible.slice(0, 150).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", text: clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.getAttribute("name")).slice(0, 160), name: el.getAttribute("name") || "", placeholder: el.getAttribute("placeholder") || "", ariaLabel: el.getAttribute("aria-label") || "", disabled: Boolean(el.disabled) }));
  });
}
async function openUrl({ url }, task) {
  let u; try { u = new URL(url); } catch { return "Ошибка: нужен полный URL, например https://example.com"; }
  if (!["http:", "https:"].includes(u.protocol)) return "Разрешены только http и https.";
  const urlBefore = page.url(); await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  const result = `Открыта страница: ${page.url()}\nЗаголовок: ${await page.title()}`;
  recordStep(task, "open_url", { url: u.href }, urlBefore, page.url()); return result;
}
async function readPage() {
  const controls = await visibleControls();
  const data = await page.evaluate(LIMIT => { const clean = s => String(s || "").replace(/\s+/g, " ").trim(); return { url: location.href, title: document.title, text: clean(document.body?.innerText).slice(0, LIMIT) }; }, PAGE_TEXT_LIMIT);
  return JSON.stringify({ ...data, controls }, null, 2);
}
async function fillField(args, task) {
  const field = String(args.field || ""); const value = String(args.value ?? "");
  if (sensitiveField.test(field)) return "Для безопасности не заполняю пароли и платёжные реквизиты. Введи их вручную в браузере; не отправляй их в API.";
  const urlBefore = page.url(); let loc;
  if (Number.isInteger(args.index)) loc = page.locator(visibleSelector(args.index));
  else if (field) {
    const candidates = [page.getByLabel(field, { exact: false }).first(), page.getByPlaceholder(field, { exact: false }).first(), page.locator(`[name="${field.replaceAll('"', '\\"')}"]`).first()];
    for (const candidate of candidates) { try { if (await candidate.count() && await candidate.isVisible()) { loc = candidate; break; } } catch {} }
  }
  if (!loc) return `Не нашёл доступное поле «${field || args.index}». Сначала вызови read_page.`;
  try {
    if (!(await loc.count()) || !(await loc.isVisible())) return "Элемент не найден или не виден. Повтори read_page и используй новый индекс.";
    const meta = await loc.evaluate(el => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") || "").toLowerCase(), name: el.getAttribute("name") || "", placeholder: el.getAttribute("placeholder") || "", label: el.getAttribute("aria-label") || "" }));
    if (sensitiveField.test([meta.type, meta.name, meta.placeholder, meta.label].join(" "))) return "Для безопасности не заполняю парольные и платёжные поля.";
    await loc.fill(value, { timeout: 5000 }); recordStep(task, "fill_field", { ...(Number.isInteger(args.index) ? { index: args.index } : { field }), value }, urlBefore, page.url());
    return `Поле «${field || `#${args.index}`}» заполнено.`;
  } catch (e) { return `Не удалось заполнить поле: ${e.message}`; }
}
async function clickText(task, args) {
  const text = String(args.text || ""); const urlBefore = page.url(); let loc;
  try {
    if (Number.isInteger(args.index)) loc = page.locator(visibleSelector(args.index));
    else {
      if (!text) return "Укажи text или index.";
      loc = page.getByRole("button", { name: text, exact: false }).first();
      if (!(await loc.count())) loc = page.getByRole("link", { name: text, exact: false }).first();
      if (!(await loc.count())) loc = page.getByText(text, { exact: false }).first();
    }
    if (!(await loc.count()) || !(await loc.isVisible())) return `Не найден видимый элемент «${text || `#${args.index}`}». Повтори read_page.`;
    const meta = await loc.evaluate(el => { const c = el.closest('button,input[type="submit"],input[type="button"],a,[role="button"]') || el; return { label: (c.innerText || c.getAttribute("aria-label") || c.value || "").trim(), type: (c.getAttribute("type") || "").toLowerCase(), tag: c.tagName.toLowerCase(), inForm: Boolean(c.closest("form")), href: c.href || "" }; });
    const label = meta.label || text || `#${args.index}`;
    const needsApproval = meta.type === "submit" || (meta.inForm && ["button", "input"].includes(meta.tag)) || finalAction.test(`${text} ${label}`);
    if (needsApproval) {
      const answer = await waitApproval(task, { type: "final_action", label, url: page.url(), href: meta.href || null, actionText: text, notice: "Подтверждение разрешает одно нажатие. Проверь сайт, действие, сумму и детали перед подтверждением." });
      if (!answer) return "Пользователь отклонил действие. Ничего не нажато.";
    }
    await loc.click({ timeout: 8000 }); await page.waitForTimeout(700);
    if (!needsApproval) recordStep(task, "click_text", Number.isInteger(args.index) ? { index: args.index } : { text }, urlBefore, page.url());
    return `Нажат элемент «${label}». Текущий URL: ${page.url()}`;
  } catch (e) { return `Не удалось нажать «${text || args.index}»: ${e.message}`; }
}
async function requestHumanAction(task, { reason, actionRequired }) {
  const answer = await waitApproval(task, { type: "human_intervention", label: reason, reason, actionRequired, url: page.url(), notice: "Откройте браузерную сессию, выполните действие вручную, затем вызовите POST /tasks/:id/confirm. Не отправляйте пароль или одноразовый код в чат." });
  return answer ? "Пользователь подтвердил ручное действие. Продолжай с текущей страницы и проверь состояние." : "Пользователь отклонил ручное вмешательство. Останови задачу.";
}
function recordStep(task, tool, args, urlBefore, urlAfter) {
  if (!task || !task.recordedSteps) return;
  task.recordedSteps.push({ tool, args, urlBefore, urlAfter });
}
function templateValue(value, params) {
  if (typeof value === "string") {
    let out = value;
    for (const [key, paramValue] of Object.entries(params || {})) if (String(paramValue) && out.includes(String(paramValue))) out = out.split(String(paramValue)).join(`{{${key}}}`);
    return out;
  }
  if (Array.isArray(value)) return value.map(v => templateValue(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templateValue(v, params)]));
  return value;
}
function compileWorkflow(task) {
  const name = String(task.saveAsWorkflow || "").trim();
  if (!name || !task.recordedSteps?.length) return null;
  const steps = task.recordedSteps.map(s => ({ ...s, args: templateValue(s.args, task.params || {}) }));
  workflows[name] = { name, description: task.prompt.slice(0, 500), createdAt: new Date().toISOString(), params: task.params || {}, steps };
  return saveWorkflows().then(() => ({ name, stepCount: steps.length }));
}

async function runTask(t) {
  update(t, { status: "running" });
  log(t, "Задача запущена через Amazon Bedrock Converse");

  const saved = findMemory(t.prompt).slice(0, 5);
  const systemPrompt =
    `${instructions}\n\nСохранённая память (может быть неполной; ищи дополнительно через memory_search):\n${JSON.stringify(saved)}`;

  let messages = [
    { role: "user", content: [{ text: t.prompt }] }
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (t.cancelled) {
        update(t, { status: "cancelled", result: "Задача отменена." });
        return;
      }

      const response = await callBedrock(messages, systemPrompt);
      const msg = response.output.message;
      messages.push(msg);

      const blocks = msg.content || [];
      const toolCalls = blocks.filter(block => block.toolUse);

      if (!toolCalls.length) {
        const answer = blocks
          .filter(block => typeof block.text === "string")
          .map(block => block.text)
          .join("\n")
          .trim();

        update(t, {
          status: "completed",
          result: answer || "Задача завершена."
        });
        log(t, "Задача завершена");

        if (t.saveAsWorkflow) {
          const wf = await compileWorkflow(t);
          if (wf) {
            t.workflow = wf;
            log(t, `Workflow сохранён: ${wf.name} (${wf.stepCount} шагов)`);
          } else {
            log(t, "Workflow не сохранён: не было записанных действий.");
          }
        }
        return;
      }

      const toolResults = [];

      for (const block of toolCalls) {
        const call = block.toolUse;
        const name = call.name;
        const args = call.input || {};

        log(t, `Инструмент: ${name}`);
        let result;

        try {
          switch (name) {
            case "open_url":
              result = await openUrl(args, t);
              break;

            case "read_page": {
              const snapshot = await readPage();
              if (humanCheck.test(snapshot)) {
                result =
                  `${snapshot}\n\nВНИМАНИЕ: на странице обнаружена возможная CAPTCHA/проверка/авторизация. Не пытайся её обходить; вызови request_human_action.`;
              } else {
                result = snapshot;
              }
              break;
            }

            case "fill_field":
              result = await fillField(args, t);
              break;

            case "click_text":
              result = await clickText(t, args);
              break;

            case "memory_search":
              result = JSON.stringify(findMemory(args.query || ""));
              break;

            case "memory_save": {
              const value = String(args.text || "").trim().slice(0, 1000);

              if (!value) {
                result = "Пустую запись сохранить нельзя.";
              } else if (
                sensitiveField.test(value) ||
                /(api[_ -]?key|bearer\s|password|пароль|токен|cvv|одноразовый код)/i.test(value)
              ) {
                result = "Похоже, запись содержит секретные данные; не сохраняю.";
              } else {
                const now = new Date().toISOString();
                const existing = memory.find(
                  x => x.text.toLowerCase() === value.toLowerCase()
                );

                if (existing) {
                  existing.updatedAt = now;
                  existing.tags = Array.isArray(args.tags)
                    ? args.tags.slice(0, 10)
                    : existing.tags;
                } else {
                  memory.push({
                    id: randomUUID(),
                    text: value,
                    tags: Array.isArray(args.tags) ? args.tags.slice(0, 10) : [],
                    createdAt: now,
                    updatedAt: now
                  });
                }

                memory = memory.slice(-500);
                await saveMemory();
                result = "Запись сохранена в постоянную память.";
              }
              break;
            }

            case "request_human_action":
              result = await requestHumanAction(t, args);
              break;

            default:
              result = "Неизвестный инструмент.";
          }
        } catch (e) {
          result = `Ошибка инструмента: ${e.message}`;
        }

        const resultText = String(result).slice(0, 10000);
        log(t, resultText.slice(0, 1500));

        toolResults.push({
          toolResult: {
            toolUseId: call.toolUseId,
            content: [{ text: resultText }]
          }
        });

        if (t.status === "awaiting_confirmation") {
          update(t, { status: "running", approval: null });
        }

        if (t.cancelled) {
          update(t, { status: "cancelled", result: "Задача отменена." });
          return;
        }
      }

      messages.push({
        role: "user",
        content: toolResults
      });
    }

    update(t, {
      status: "failed",
      error: `Достигнут лимит ${MAX_STEPS} шагов без завершения.`
    });
  } catch (e) {
    update(t, { status: "failed", error: e.message });
    log(t, `Ошибка: ${e.message}`);
  }
}

function interpolate(value, params) {
  if (typeof value === "string") return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => params?.[key] === undefined ? `{{${key}}}` : String(params[key]));
  if (Array.isArray(value)) return value.map(v => interpolate(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, params)]));
  return value;
}
async function runWorkflow(name, params = {}) {
  const wf = workflows[name]; if (!wf) throw new Error(`Workflow «${name}» не найден`);
  const results = [];
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i]; const args = interpolate(step.args, params); const before = page.url();
    if (step.tool === "open_url") await openUrl(args, null);
    else if (step.tool === "fill_field") { await visibleControls(); const r = await fillField(args, null); if (String(r).startsWith("Не удалось") || String(r).startsWith("Не нашёл") || String(r).startsWith("Элемент не найден")) throw new Error(`Шаг ${i + 1}: ${r}`); }
    else if (step.tool === "click_text") { await visibleControls(); const r = await clickText({ logs: [], id: "workflow", resolveApproval: null }, args); if (String(r).startsWith("Не удалось") || String(r).startsWith("Не найден")) throw new Error(`Шаг ${i + 1}: ${r}`); }
    else throw new Error(`Неподдерживаемый шаг workflow: ${step.tool}`);
    results.push({ step: i + 1, tool: step.tool, urlBefore: before, urlAfter: page.url() });
  }
  return { ok: true, workflow: name, stepsExecuted: results.length, results };
}
function send(res, status, obj) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj, null, 2)); }
function authorized(req) { const h = req.headers.authorization || ""; const token = h.startsWith("Bearer ") ? h.slice(7) : ""; if (!token || token.length !== API_TOKEN.length) return false; try { return timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN)); } catch { return false; } }
async function body(req) { let s = ""; for await (const chunk of req) { s += chunk; if (s.length > 100_000) throw new Error("Тело запроса слишком большое (лимит 100 КБ)"); } return s ? JSON.parse(s) : {}; }
function enqueue(fn) { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; }
const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") return send(res, 200, { ok: true, service: "ai-browser-agent-api" });
  if (!authorized(req)) return send(res, 401, { error: "Unauthorized", message: "Передайте Authorization: Bearer <API_TOKEN>" });
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/" && req.method === "GET") return send(res, 200, { service: "ai-browser-agent-api", model: MODEL, endpoints: ["POST /tasks", "GET /tasks/:id", "POST /tasks/:id/confirm", "POST /tasks/:id/reject", "POST /tasks/:id/cancel", "GET /memory", "POST /memory", "GET /workflows", "POST /workflows/:name/run"] });
    if (url.pathname === "/memory" && req.method === "GET") return send(res, 200, { count: memory.length, memory });
    if (url.pathname === "/memory" && req.method === "POST") { const b = await body(req); const value = String(b.text || "").trim().slice(0, 1000); if (!value) return send(res, 400, { error: "Поле text обязательно" }); if (sensitiveField.test(value) || /(api[_ -]?key|bearer\s|password|пароль|токен|cvv|одноразовый код)/i.test(value)) return send(res, 400, { error: "Не сохраняйте секреты или платёжные данные" }); memory.push({ id: randomUUID(), text: value, tags: Array.isArray(b.tags) ? b.tags.slice(0, 10) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); memory = memory.slice(-500); await saveMemory(); return send(res, 201, { ok: true, count: memory.length }); }
    if (url.pathname === "/workflows" && req.method === "GET") return send(res, 200, { count: Object.keys(workflows).length, workflows: Object.values(workflows).map(({ name, description, createdAt, params, steps }) => ({ name, description, createdAt, params, stepCount: steps.length })) });
    const wfMatch = url.pathname.match(/^\/workflows\/([^/]+)\/run$/);
    if (wfMatch && req.method === "POST") { const name = decodeURIComponent(wfMatch[1]); const b = await body(req); const result = await enqueue(() => runWorkflow(name, b.params || {})); return send(res, 200, result); }
    if (url.pathname === "/tasks" && req.method === "POST") {
      const b = await body(req); if (typeof b.prompt !== "string" || !b.prompt.trim()) return send(res, 400, { error: "Поле prompt обязательно и должно быть строкой" });
      if (b.saveAsWorkflow !== undefined && (typeof b.saveAsWorkflow !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(b.saveAsWorkflow))) return send(res, 400, { error: "saveAsWorkflow должен содержать 1–80 символов: латиница, цифры, _ или -" });
      const t = { id: randomUUID(), status: "queued", prompt: b.prompt.trim().slice(0, 10000), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logs: [], approval: null, result: null, error: null, recordedSteps: [], saveAsWorkflow: b.saveAsWorkflow || null, params: b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {} };
      tasks.set(t.id, t); enqueue(async () => { if (!t.cancelled) await runTask(t); }); return send(res, 202, { task: publicTask(t), poll: `GET /tasks/${t.id}` });
    }
    const m = url.pathname.match(/^\/tasks\/([0-9a-f-]+)(?:\/(confirm|reject|cancel))?$/i);
    if (m) {
      const t = tasks.get(m[1]); if (!t) return send(res, 404, { error: "Task not found" }); const action = m[2];
      if (req.method === "GET" && !action) return send(res, 200, { task: publicTask(t), workflow: t.workflow || null });
      if (req.method === "POST" && action === "confirm") { if (t.status !== "awaiting_confirmation" || !t.resolveApproval) return send(res, 409, { error: "Эта задача сейчас не ожидает подтверждения" }); const resolve = t.resolveApproval; t.resolveApproval = null; resolve(true); return send(res, 200, { ok: true, message: "Подтверждение принято; агент продолжит выполнение." }); }
      if (req.method === "POST" && action === "reject") { if (t.status !== "awaiting_confirmation" || !t.resolveApproval) return send(res, 409, { error: "Эта задача сейчас не ожидает подтверждения" }); const resolve = t.resolveApproval; t.resolveApproval = null; resolve(false); return send(res, 200, { ok: true, message: "Действие отклонено." }); }
      if (req.method === "POST" && action === "cancel") { t.cancelled = true; if (t.resolveApproval) { const resolve = t.resolveApproval; t.resolveApproval = null; resolve(false); } update(t, { status: "cancelled", result: "Задача отменена." }); return send(res, 200, { ok: true, task: publicTask(t) }); }
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) { return send(res, 400, { error: "Bad request", message: e.message }); }
});
await loadData();
browserContext = await chromium.launchPersistentContext(path.resolve("browser-profile"), { headless: HEADLESS, viewport: { width: 1440, height: 900 }, args: ["--no-sandbox"] });
page = browserContext.pages()[0] || await browserContext.newPage();
server.listen(PORT, "0.0.0.0", () => console.log(`AI Browser Agent API слушает порт ${PORT}; model=${MODEL}; headless=${HEADLESS}`));
async function shutdown() { server.close(); await browserContext?.close(); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
