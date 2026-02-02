import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;

// ================= CACHE (MVP) =================
let CACHE = { updatedAt: 0, items: [] };
const SENT_URLS = new Set(); // evita alertas repetidos

// ================= REGRAS DE IMPACTO =================
const IMPACT_KEYWORDS = [
  { re: /imposto|tribut|taxa|alíquota|arrecadaç/i, w: 40 },
  { re: /selic|juros|copom|inflação|ipca/i, w: 35 },
  { re: /dólar|câmbio|real|moeda/i, w: 20 },
  { re: /congresso|senado|câmara|plenário|stf|tse/i, w: 25 },
  { re: /ministério|governo|presidente|planalto/i, w: 20 },
  { re: /reforma|orçamento|arcabouço|pacote/i, w: 25 },
  { re: /petrobras|banco central|fazenda/i, w: 15 }
];

const SOURCE_BONUS = [
  { re: /reuters/i, b: 25 },
  { re: /bloomberg/i, b: 25 },
  { re: /valor|estadao|folha|g1|oglobo|uol|exame/i, b: 10 }
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ================= SCORE =================
function scoreArticle(article) {
  const text = `${article.title || ''} ${article.description || ''} ${article.content || ''}`.toLowerCase();
  let score = 0;

  for (const k of IMPACT_KEYWORDS) {
    if (k.re.test(text)) score += k.w;
  }

  const source = (article.source?.name || '').toLowerCase();
  for (const s of SOURCE_BONUS) {
    if (s.re.test(source)) score += s.b;
  }

  const published = article.publishedAt ? new Date(article.publishedAt).getTime() : 0;
  const ageMinutes = published ? (Date.now() - published) / 60000 : 999999;
  const recencyBoost = clamp(60 - ageMinutes / 12, 0, 60);
  score += recencyBoost;

  return Math.round(score);
}

function impactLabel(score) {
  if (score >= 90) return { level: "high", dot: "🔴", label: "Alto" };
  if (score >= 60) return { level: "mid", dot: "🟡", label: "Médio" };
  return { level: "low", dot: "🟢", label: "Baixo" };
}

// ================= RESUMO =================
function summarize(article) {
  const base = article.description || article.content || "";
  const clean = base.replace(/\s+/g, " ").trim();
  if (!clean) return "Sem resumo disponível.";
  return clean.length > 180 ? clean.slice(0, 177) + "..." : clean;
}

// ================= BUSCAR NOTÍCIAS =================
async function fetchNews() {
  if (!NEWSAPI_KEY) throw new Error("NEWSAPI_KEY não configurada");

  const urlTop =
    `https://newsapi.org/v2/top-headlines?country=br&category=business&pageSize=30&apiKey=${NEWSAPI_KEY}`;

  const urlAll =
    `https://newsapi.org/v2/everything?q=política%20OR%20economia%20OR%20congresso%20OR%20governo%20OR%20imposto&language=pt&sortBy=popularity&pageSize=50&apiKey=${NEWSAPI_KEY}`;

  const [r1, r2] = await Promise.all([fetch(urlTop), fetch(urlAll)]);
  const d1 = await r1.json();
  const d2 = await r2.json();

  const all = [...(d1.articles || []), ...(d2.articles || [])];

  const map = new Map();
  for (const a of all) {
    if (a?.url && !map.has(a.url)) map.set(a.url, a);
  }

  const items = Array.from(map.values()).map(a => {
    const score = scoreArticle(a);
    return {
      title: a.title,
      url: a.url,
      source: a.source?.name || "Fonte",
      publishedAt: a.publishedAt,
      score,
      impact: impactLabel(score),
      summary: summarize(a)
    };
  });

  items.sort((a, b) => b.score - a.score);
  return items.slice(0, 30);
}

// ================= ALERTA WHATSAPP (OPCIONAL) =================
async function sendWhatsAppAlert(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_WHATSAPP_TO;

  if (!sid || !token || !from || !to) return;

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: message
    })
  });
}

// ================= ATUALIZAÇÃO + ALERTAS =================
async function refreshCacheAndAlert() {
  const items = await fetchNews();
  CACHE = { updatedAt: Date.now(), items };

  const breaking = items.filter(i => i.score >= 95);

  for (const b of breaking) {
    if (SENT_URLS.has(b.url)) continue;
    SENT_URLS.add(b.url);

    const msg =
      `${b.impact.dot} [Data_Pulse01]\n` +
      `${b.title}\n` +
      `${b.summary}\n` +
      `${b.url}`;

    await sendWhatsAppAlert(msg);
  }
}

// ================= ENDPOINT =================
app.get('/api/news', async (req, res) => {
  try {
    if (Date.now() - CACHE.updatedAt < 3 * 60 * 1000 && CACHE.items.length) {
      return res.json(CACHE);
    }
    await refreshCacheAndAlert();
    res.json(CACHE);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= CRON =================
cron.schedule('*/5 * * * *', async () => {
  try {
    await refreshCacheAndAlert();
  } catch (e) {
    console.error("Erro no cron:", e.message);
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Data_Pulse01 API rodando na porta ${PORT}`);
});
