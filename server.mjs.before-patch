import "dotenv/config";
import OpenAI from "openai";
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = process.env.API_TOKEN || "";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const HEADLESS = process.env.HEADLESS !== "false";
const MAX_STEPS = Math.max(5, Math.min(60, Number(process.env.MAX_STEPS || 30)));
const MEMORY_FILE = path.resolve(process.env.MEMORY_FILE || "data/memory.json");
const PAGE_TEXT_LIMIT = Math.max(3000, Math.min(20000, Number(process.env.PAGE_TEXT_LIMIT || 10000)));
if (!API_KEY) throw new Error("Не задан OPENAI_API_KEY в .env");
if (API_TOKEN.length < 24) throw new Error("Задайте API_TOKEN длиной не менее 24 символов в .env");
const client = new OpenAI({ apiKey: API_KEY });
const tasks = new Map();
let memory = [];
async function loadMemory() { try { memory = JSON.parse(await fs.readFile(MEMORY_FILE, "utf8")); if (!Array.isArray(memory)) memory = []; } catch { memory = []; } }
async function saveMemory() { await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true }); await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), { mode: 0o600 }); }
function findMemory(query = "") { const q = String(query).toLowerCase().trim(); const words = q.split(/\s+/).filter(w => w.length > 2); return memory.map(item => ({item, score: words.reduce((n,w) => n + ((item.text + " " + (item.tags||[]).join(" ")).toLowerCase().includes(w) ? 1 : 0), 0)})).filter(x => !q || x.score > 0).sort((a,b) => b.score-a.score || b.item.updatedAt.localeCompare(a.item.updatedAt)).slice(0,8).map(x => x.item); }
let browserContext;
let page;
let queue = Promise.resolve();

const sensitiveField = /(password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|bank.?account|парол|номер карты|код карты)/i;
const finalAction = /(pay|payment|purchase|buy now|place order|confirm booking|book now|reserve now|submit|create account|register|sign up|checkout|заказать|оплатить|оплата|купить|оформить|подтвердить|забронировать|регистрац|отправить|создать аккаунт)/i;
const instructions = `Ты — браузерный помощник, работающий через API. Выполняй задачу по шагам через инструменты.
Память: используй memory_search для поиска сохранённых предпочтений и контекста. Сохраняй только долгосрочные полезные предпочтения и факты по явной просьбе пользователя или когда это явно полезно для продолжения проекта. Не сохраняй пароли, токены, платёжные данные, одноразовые коды и другие секреты.
Правила безопасности:
- Сначала изучай страницу; не выдумывай цены, наличие или результаты.
- Не обходи CAPTCHA, Cloudflare, проверки личности, ограничения доступа и антибот-защиту. При необходимости попроси человека пройти проверку вручную.
- Не запрашивай и не выводи пароли, полные номера карт, CVV, одноразовые коды или секретные ключи. Пароли и платёжные поля нельзя заполнять инструментом.
- Перед отправкой формы, регистрацией, бронированием, заказом или оплатой обязательно дождись отдельного подтверждения через API. До подтверждения действие не выполняется.
- Перед подтверждением сообщи видимые детали: сайт, вариант, дату, сумму и валюту, если доступны. Не угадывай отсутствующие данные.
- После важных действий проверь результат. Используй только сайты и аккаунты, к которым пользователь имеет право доступа.`;

function update(task, patch) { Object.assign(task, patch, { updatedAt: new Date().toISOString() }); }
function publicTask(t) {
  return { id:t.id, status:t.status, prompt:t.prompt, createdAt:t.createdAt, updatedAt:t.updatedAt,
    result:t.result ?? null, error:t.error ?? null, currentUrl:page?.url?.() || null,
    approval:t.status === "awaiting_confirmation" ? t.approval : undefined,
    logs:t.logs };
}
function log(t, message) { t.logs.push({ at:new Date().toISOString(), message:String(message).slice(0,3000) }); if(t.logs.length>100) t.logs.shift(); }

function toolsFor(task) {
 return [
  {type:"function",function:{name:"open_url",description:"Открыть страницу по полному HTTP/HTTPS URL",parameters:{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false}}},
  {type:"function",function:{name:"read_page",description:"Прочитать текст страницы и видимые элементы управления",parameters:{type:"object",properties:{},required:[],additionalProperties:false}}},
  {type:"function",function:{name:"click_text",description:"Нажать кнопку/ссылку по видимому тексту. Для финальных действий требуется подтверждение через API.",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}},
  {type:"function",function:{name:"fill_field",description:"Заполнить обычное поле по подписи/placeholder/name. Не заполнять пароли и платёжные реквизиты.",parameters:{type:"object",properties:{field:{type:"string"},value:{type:"string"}},required:["field","value"],additionalProperties:false}}}
 ];
}
async function openUrl({url}) {
 let u; try { u=new URL(url); } catch { return "Ошибка: нужен полный URL, например https://example.com"; }
 if(!["http:","https:"].includes(u.protocol)) return "Разрешены только http и https.";
 await page.goto(u.href,{waitUntil:"domcontentloaded",timeout:45000});
 return `Открыта страница: ${page.url()}\nЗаголовок: ${await page.title()}`;
}
async function readPage() {
 const data=await page.evaluate((LIMIT)=>{const clean=s=>(s||"").replace(/\s+/g," ").trim();return {url:location.href,title:document.title,text:clean(document.body?.innerText).slice(0,LIMIT),controls:[...document.querySelectorAll("input,textarea,select,button,a,[role=button]")].slice(0,100).map((el,i)=>({index:i,tag:el.tagName.toLowerCase(),type:el.getAttribute("type")||"",text:clean(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.value||el.getAttribute("name")).slice(0,160),name:el.getAttribute("name")||"",placeholder:el.getAttribute("placeholder")||"",ariaLabel:el.getAttribute("aria-label")||"",disabled:Boolean(el.disabled)}))}},PAGE_TEXT_LIMIT);
 return JSON.stringify(data,null,2);
}
async function fillField({field,value}) {
 if(sensitiveField.test(field)) return "Для безопасности не заполняю пароли и платёжные реквизиты. Введи их вручную в браузере; не отправляй их в API.";
 const candidates=[page.getByLabel(field,{exact:false}).first(),page.getByPlaceholder(field,{exact:false}).first(),page.locator(`[name="${String(field).replaceAll('"','\\"')}"]`).first()];
 for(const loc of candidates){try{if(await loc.count()){await loc.fill(String(value),{timeout:3000});return `Поле «${field}» заполнено.`}}catch{}}
 return `Не нашёл доступное поле «${field}». Сначала вызови read_page.`;
}
function waitApproval(task, details) {
 update(task,{status:"awaiting_confirmation",approval:{...details,required:true}});
 log(task,`Ожидает подтверждения: ${details.label} на ${details.url}`);
 return new Promise(resolve=>{task.resolveApproval=resolve;});
}
async function clickText(task,{text}) {
 let loc=page.getByRole("button",{name:text,exact:false}).first();
 try { if(!(await loc.count())) loc=page.getByRole("link",{name:text,exact:false}).first(); if(!(await loc.count())) loc=page.getByText(text,{exact:false}).first(); if(!(await loc.count())) return `Не найден элемент «${text}».`;
  const meta=await loc.evaluate(el=>{const c=el.closest('button,input[type="submit"],input[type="button"],a,[role="button"]')||el;return {label:(c.innerText||c.getAttribute("aria-label")||c.value||"").trim(),type:(c.getAttribute("type")||"").toLowerCase(),tag:c.tagName.toLowerCase(),inForm:Boolean(c.closest("form")),href:c.href||""}});
  const needsApproval=meta.type==="submit"||(meta.inForm&&(meta.tag==="button"||meta.tag==="input"))||finalAction.test(`${text} ${meta.label}`);
  if(needsApproval){
   const answer=await waitApproval(task,{label:meta.label||text,url:page.url(),href:meta.href||null,actionText:text,notice:"Подтверждение разрешает одно нажатие. Проверьте страницу, цену и детали перед подтверждением."});
   if(!answer) return "Пользователь отклонил действие. Ничего не нажато.";
   // Resolve and click only after explicit API confirmation.
  }
  await loc.click({timeout:8000}); await page.waitForTimeout(900); return `Нажат элемент «${meta.label||text}». Текущий URL: ${page.url()}`;
 } catch(e){return `Не удалось нажать «${text}»: ${e.message}`}
}
async function runTask(t) {
 update(t,{status:"running"}); log(t,"Задача запущена");
 let messages=[{role:"system",content:instructions + "\n\nСохранённая память (может быть неполной; ищи дополнительно через memory_search):\n" + JSON.stringify(findMemory(t.prompt).slice(0,5))},{role:"user",content:t.prompt}];
 try {
  for(let step=0;step<MAX_STEPS;step++){
   if(t.cancelled){update(t,{status:"cancelled",result:"Задача отменена."});return}
   const response=await client.chat.completions.create({model:MODEL,messages,tools:toolsFor(t),tool_choice:"auto",temperature:0.2});
   const msg=response.choices[0].message; messages.push(msg);
   if(!msg.tool_calls?.length){update(t,{status:"completed",result:msg.content||"Задача завершена."});log(t,"Задача завершена");return}
   for(const call of msg.tool_calls){let args={};try{args=JSON.parse(call.function.arguments||"{}")}catch{}
    log(t,`Инструмент: ${call.function.name}`); let result;
    try{
     switch(call.function.name){case"open_url":result=await openUrl(args);break;case"read_page":result=await readPage();break;case"fill_field":result=await fillField(args);break;case"click_text":result=await clickText(t,args);break;
     case"memory_search":result=JSON.stringify(findMemory(args.query||""));break;
     case"memory_save":{
      const value=String(args.text||"").trim().slice(0,1000);
      if(!value) result="Пустую запись сохранить нельзя.";
      else if(sensitiveField.test(value)||/(api[_ -]?key|bearer\\s|password|пароль|токен|cvv|одноразовый код)/i.test(value)) result="Похоже, запись содержит секретные данные; не сохраняю.";
      else {const now=new Date().toISOString();const existing=memory.find(x=>x.text.toLowerCase()===value.toLowerCase());if(existing){existing.updatedAt=now;existing.tags=Array.isArray(args.tags)?args.tags.slice(0,10):existing.tags;}else memory.push({id:randomUUID(),text:value,tags:Array.isArray(args.tags)?args.tags.slice(0,10):[],createdAt:now,updatedAt:now});memory=memory.slice(-500);await saveMemory();result="Запись сохранена в постоянную память."}
      break;
     }
     default:result="Неизвестный инструмент."}
    }catch(e){result=`Ошибка инструмента: ${e.message}`}
    log(t,String(result).slice(0,1500));
    messages.push({role:"tool",tool_call_id:call.id,content:String(result).slice(0,10000)});
    if(t.status==="awaiting_confirmation") update(t,{status:"running",approval:null});
   }
  }
  update(t,{status:"completed",result:"Остановлено: достигнут лимит 30 шагов."});
 } catch(e){update(t,{status:"failed",error:e.message});log(t,`Ошибка: ${e.message}`)}
}
// Confirmation promise is coordinated inside clickText; this wrapper lets the waiting click continue.
const originalWaitApproval=waitApproval;
waitApproval=function(task,details){
 update(task,{status:"awaiting_confirmation",approval:{...details,required:true}}); log(task,`Ожидает подтверждения: ${details.label}`);
 return new Promise(resolve=>{task.resolveApproval=resolve;});
};

function send(res,status,obj){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(obj,null,2));}
function authorized(req){const h=req.headers.authorization||"";const token=h.startsWith("Bearer ")?h.slice(7):"";if(!token||token.length!==API_TOKEN.length)return false;try{return timingSafeEqual(Buffer.from(token),Buffer.from(API_TOKEN))}catch{return false}}
async function body(req){let s="";for await(const chunk of req){s+=chunk;if(s.length>100_000)throw new Error("Тело запроса слишком большое (лимит 100 КБ)")}return s?JSON.parse(s):{}}
const server=http.createServer(async(req,res)=>{
 if(req.url==="/health"&&req.method==="GET")return send(res,200,{ok:true,service:"ai-browser-agent-api"});
 if(!authorized(req))return send(res,401,{error:"Unauthorized",message:"Передайте Authorization: Bearer <API_TOKEN>"});
 const url=new URL(req.url,"http://localhost");
 try{
  if(url.pathname==="/"&&req.method==="GET")return send(res,200,{service:"ai-browser-agent-api",model:MODEL,endpoints:["POST /tasks","GET /tasks/:id","POST /tasks/:id/confirm","POST /tasks/:id/reject","POST /tasks/:id/cancel","GET /memory","POST /memory"]});
  if(url.pathname==="/memory"&&req.method==="GET")return send(res,200,{count:memory.length,memory});
  if(url.pathname==="/memory"&&req.method==="POST"){
   const b=await body(req);const value=String(b.text||"").trim().slice(0,1000);
   if(!value)return send(res,400,{error:"Поле text обязательно"});
   if(sensitiveField.test(value)||/(api[_ -]?key|bearer\\s|password|пароль|токен|cvv|одноразовый код)/i.test(value))return send(res,400,{error:"Не сохраняйте секреты или платёжные данные"});
   const now=new Date().toISOString();memory.push({id:randomUUID(),text:value,tags:Array.isArray(b.tags)?b.tags.slice(0,10):[],createdAt:now,updatedAt:now});memory=memory.slice(-500);await saveMemory();return send(res,201,{ok:true,count:memory.length});
  }
  if(url.pathname==="/tasks"&&req.method==="POST"){
   const b=await body(req);if(typeof b.prompt!=="string"||!b.prompt.trim())return send(res,400,{error:"Поле prompt обязательно и должно быть строкой"});
   const t={id:randomUUID(),status:"queued",prompt:b.prompt.trim().slice(0,10000),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),logs:[],approval:null,result:null,error:null};tasks.set(t.id,t);
   queue=queue.then(async()=>{if(!t.cancelled)await runTask(t)}).catch(e=>{update(t,{status:"failed",error:e.message})});
   return send(res,202,{task:publicTask(t),poll:`GET /tasks/${t.id}`});
  }
  const m=url.pathname.match(/^\/tasks\/([0-9a-f-]+)(?:\/(confirm|reject|cancel))?$/i);
  if(m){const t=tasks.get(m[1]);if(!t)return send(res,404,{error:"Task not found"});const action=m[2];
   if(req.method==="GET"&&!action)return send(res,200,{task:publicTask(t)});
   if(req.method==="POST"&&action==="confirm"){
    if(t.status!=="awaiting_confirmation"||!t.resolveApproval)return send(res,409,{error:"Эта задача сейчас не ожидает подтверждения"});
    t.resolveApproval(true);t.resolveApproval=null;
    return send(res,200,{ok:true,message:"Подтверждение принято; агент выполнит ожидающее действие."});
   }
   if(req.method==="POST"&&action==="reject"){
    if(t.status!=="awaiting_confirmation"||!t.resolveApproval)return send(res,409,{error:"Эта задача сейчас не ожидает подтверждения"});
    t.resolveApproval(false);t.resolveApproval=null;
    return send(res,200,{ok:true,message:"Действие отклонено."});
   }
   if(req.method==="POST"&&action==="cancel"){
    t.cancelled=true;if(t.resolveApproval){t.resolveApproval(false);t.resolveApproval=null}update(t,{status:"cancelled",result:"Задача отменена."});return send(res,200,{ok:true,task:publicTask(t)});
   }
  }
  return send(res,404,{error:"Not found"});
 }catch(e){return send(res,400,{error:"Bad request",message:e.message})}
});

await loadMemory();
browserContext=await chromium.launchPersistentContext(path.resolve("browser-profile"),{headless:HEADLESS,viewport:{width:1440,height:900},args:["--no-sandbox"]});
page=browserContext.pages()[0]||await browserContext.newPage();
server.listen(PORT,"0.0.0.0",()=>console.log(`AI Browser Agent API слушает порт ${PORT}; model=${MODEL}; headless=${HEADLESS}`));
async function shutdown(){server.close();await browserContext?.close();process.exit(0)}
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
