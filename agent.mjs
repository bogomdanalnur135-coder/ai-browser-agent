import "dotenv/config";
import OpenAI from "openai";
import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY. Создай .env по образцу .env.example.");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = async (q) => (await rl.question(q)).trim();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4.1";

let context;
let page;

const sensitiveField = /(password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|bank.?account|парол|номер карты|код карты|cvc|cvv)/i;
const finalAction = /(pay|payment|purchase|buy now|place order|confirm booking|book now|reserve now|submit|create account|register|sign up|checkout|заказать|оплатить|оплата|купить|оформить|подтвердить|забронировать|регистрац|отправить|создать аккаунт)/i;

async function openUrl({ url }) {
  let parsed;
  try { parsed = new URL(url); } catch { return "Ошибка: нужен полный URL, например https://example.com"; }
  if (!["http:", "https:"].includes(parsed.protocol)) return "Разрешены только http и https.";
  await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  return `Открыта страница: ${page.url()}\nЗаголовок: ${await page.title()}`;
}

async function readPage() {
  const data = await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const text = clean(document.body?.innerText).slice(0, 14000);
    const controls = [...document.querySelectorAll("input, textarea, select, button, a, [role=button]")]
      .slice(0, 100).map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        text: clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.getAttribute("name")).slice(0, 160),
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        disabled: Boolean(el.disabled)
      }));
    return { url: location.href, title: document.title, text, controls };
  });
  return JSON.stringify(data, null, 2);
}

async function fillField({ field, value }) {
  if (sensitiveField.test(field)) {
    return "Для безопасности я не заполняю пароли и платёжные реквизиты. Введи их вручную в открытом браузере; не отправляй их в чат.";
  }
  const candidates = [
    page.getByLabel(field, { exact: false }).first(),
    page.getByPlaceholder(field, { exact: false }).first(),
    page.locator(`[name="${String(field).replaceAll('"', '\\"')}"]`).first()
  ];
  for (const loc of candidates) {
    try {
      if (await loc.count()) {
        await loc.fill(String(value), { timeout: 3000 });
        return `Поле «${field}» заполнено.`;
      }
    } catch {}
  }
  return `Не нашёл доступное поле «${field}». Сначала вызови read_page и используй точную подпись/placeholder/name.`;
}

async function clickText({ text }) {
  // First prefer semantic buttons and links.
  let loc = page.getByRole("button", { name: text, exact: false }).first();
  let kind = "button";
  try {
    if (!(await loc.count())) {
      loc = page.getByRole("link", { name: text, exact: false }).first();
      kind = "link";
    }
    if (!(await loc.count())) {
      loc = page.getByText(text, { exact: false }).first();
      kind = "element";
    }
    if (!(await loc.count())) return `Не найден элемент с текстом «${text}». Проверь страницу через read_page.`;

    const meta = await loc.evaluate(el => {
      const clickable = el.closest('button, input[type="submit"], input[type="button"], a, [role="button"]') || el;
      const label = (clickable.innerText || clickable.getAttribute("aria-label") || clickable.value || "").trim();
      const type = (clickable.getAttribute("type") || "").toLowerCase();
      const tag = clickable.tagName.toLowerCase();
      const inForm = Boolean(clickable.closest("form"));
      return { label, type, tag, inForm, href: clickable.href || "" };
    });

    const needsApproval = meta.type === "submit" || (meta.inForm && (meta.tag === "button" || meta.tag === "input")) || finalAction.test(`${text} ${meta.label}`);
    if (needsApproval) {
      console.log("\nТребуется подтверждение перед действием:");
      console.log(`Элемент: ${meta.label || text}`);
      console.log(`Страница: ${page.url()}`);
      if (meta.href) console.log(`Ссылка: ${meta.href}`);
      const answer = (await ask("Разрешить это действие? Введи YES для продолжения: ")).trim();
      if (answer !== "YES") return "Действие отменено пользователем. Ничего не нажато.";
    }
    await loc.click({ timeout: 8000 });
    await page.waitForTimeout(900);
    return `Нажат элемент «${meta.label || text}». Текущий URL: ${page.url()}`;
  } catch (e) {
    return `Не удалось нажать «${text}»: ${e.message}. Проверь страницу и попробуй более точное название.`;
  }
}

const tools = [
  {
    type: "function", function: {
      name: "open_url",
      description: "Открыть сайт по полному HTTP/HTTPS URL.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }
    }
  },
  {
    type: "function", function: {
      name: "read_page",
      description: "Прочитать текст страницы и список доступных кнопок, ссылок и полей.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
    }
  },
  {
    type: "function", function: {
      name: "click_text",
      description: "Нажать кнопку, ссылку или элемент по видимому тексту. Для отправки формы, регистрации, бронирования и оплаты приложение запросит подтверждение в терминале.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }
    }
  },
  {
    type: "function", function: {
      name: "fill_field",
      description: "Заполнить обычное текстовое поле по подписи, placeholder или name. Не использовать для паролей и платёжных реквизитов.",
      parameters: { type: "object", properties: { field: { type: "string" }, value: { type: "string" } }, required: ["field", "value"], additionalProperties: false }
    }
  }
];

const instructions = `Ты — локальный браузерный помощник. Выполняй задания пользователя по шагам через предоставленные инструменты.
Правила:
- Сначала изучи страницу через read_page; не выдумывай цены, наличие, подтверждения или результаты.
- Пользуйся только сайтами и аккаунтами, к которым пользователь имеет право доступа.
- Не пытайся обходить CAPTCHA, Cloudflare, проверки личности, лимиты доступа или антибот-защиту. Если появляется такая проверка, объясни пользователю, что он должен пройти её вручную; не заявляй, что она пройдена.
- Не запрашивай и не выводи пароли, полные номера карт, CVV, одноразовые коды или секретные ключи. Пользователь вводит их непосредственно в браузере.
- Перед отправкой регистрации, созданием аккаунта, отправкой формы, бронированием, заказом или оплатой click_text попросит подтверждение. Сначала покажи пользователю итоговые детали и цену, если они видны, и только затем нажимай соответствующую кнопку.
- Для покупки/брони всегда сообщи сайт, выбранный вариант, дату/время, сумму и валюту, если они доступны. Не угадывай отсутствующие сведения; уточняй у пользователя.
- Не делай фиктивных заявок, не используй чужие платёжные данные, не нарушай правила сайта.
- Если не знаешь, что нажимать, перечитай страницу и попроси пользователя уточнить.
- После каждого важного действия проверь результат через read_page.`;

async function runTask(task) {
  let messages = [
    { role: "system", content: instructions },
    { role: "user", content: task }
  ];
  for (let step = 0; step < 30; step++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2
    });
    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      console.log("\nОтвет агента:\n" + (msg.content || "Задание завершено."));
      return;
    }

    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      let result;
      console.log(`\n[Шаг ${step + 1}] ${call.function.name}`);
      try {
        switch (call.function.name) {
          case "open_url": result = await openUrl(args); break;
          case "read_page": result = await readPage(); break;
          case "click_text": result = await clickText(args); break;
          case "fill_field": result = await fillField(args); break;
          default: result = "Неизвестный инструмент.";
        }
      } catch (e) {
        result = `Ошибка инструмента: ${e.message}`;
      }
      console.log(String(result).slice(0, 1800));
      messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 10000) });
    }
  }
  console.log("Остановлено: достигнут лимит шагов. Уточни задачу и запусти снова.");
}

try {
  context = await chromium.launchPersistentContext(
    path.resolve("browser-profile"),
    { headless: false, viewport: { width: 1440, height: 900 } }
  );
  page = context.pages()[0] || await context.newPage();

  console.log("\n=== Локальный ИИ-браузерный агент ===");
  console.log(`Модель: ${model}`);
  console.log("Браузер открывается отдельно. Для остановки введи exit.\n");

  while (true) {
    const task = await ask("Задание > ");
    if (!task) continue;
    if (["exit", "quit", "выход"].includes(task.toLowerCase())) break;
    try { await runTask(task); }
    catch (e) { console.error("Ошибка задания:", e.message); }
  }
} finally {
  if (context) await context.close();
  rl.close();
}
