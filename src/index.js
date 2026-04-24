import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import http from "node:http";

const T = process.env.DISCORD_BOT_TOKEN;
const CH_VIG = process.env.DISCORD_CHANNEL_VIGILANZA;
const CH_CRI = process.env.DISCORD_CHANNEL_CRITICITA;
const PORT = Number(process.env.PORT) || 3000;
const INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 10 * 60 * 1000;

if (!T || !CH_VIG || !CH_CRI) {
  console.error("Missing env. DISCORD_BOT_TOKEN=" + (T ? "OK" : "MISSING") +
    " DISCORD_CHANNEL_VIGILANZA=" + (CH_VIG ? "OK" : "MISSING") +
    " DISCORD_CHANNEL_CRITICITA=" + (CH_CRI ? "OK" : "MISSING"));
  process.exit(1);
}

http.createServer((q, r) => { r.writeHead(200); r.end("ok"); })
  .listen(PORT, () => console.log("http " + PORT));

const PAGE_VIG = "https://www.protezionecivile.gov.it/it/bollettino/bollettino-di-vigilanza-meteorologica-nazionale";
const PAGE_CRI = "https://www.protezionecivile.gov.it/it/bollettino/bollettino-di-criticita";
const BASE = "https://www.protezionecivile.gov.it";
const UA = "meteo-italia-bot/1.0";

const lastPosted = { vig: null, cri: null };

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.text();
}

function findLatestPdf(html) {
  const re = /href="([^"]+\.pdf[^"]*)"/gi;
  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) matches.push(m[1]);
  if (!matches.length) return null;
  const url = matches[0].startsWith("http") ? matches[0] : BASE + matches[0];
  return url;
}

function findLatestImage(html) {
  const re = /<img[^>]+src="([^"]+\.(?:png|jpg|jpeg)[^"]*)"/gi;
  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (src.includes("logo") || src.includes("icon") || src.includes("favicon")) continue;
    matches.push(src);
  }
  if (!matches.length) return null;
  const url = matches[0].startsWith("http") ? matches[0] : BASE + matches[0];
  return url;
}

function todayStr() {
  return new Date().toLocaleDateString("it-IT", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Europe/Rome"
  });
}

function buildEmbed(kind, pdfUrl, imgUrl, pageUrl) {
  const isVig = kind === "vig";
  const e = new EmbedBuilder()
    .setColor(isVig ? 0x1e88e5 : 0xff6f00)
    .setTitle(isVig ? "🌦️ Bollettino di Vigilanza Meteorologica" : "⚠️ Bollettino di Criticità Meteo-Idro")
    .setURL(pageUrl)
    .setDescription(`**${todayStr()}**\nNuovo bollettino rilasciato dal Dipartimento della Protezione Civile.`)
    .addFields(
      { name: "📄 PDF ufficiale", value: `[Scarica il bollettino](${pdfUrl})` },
      { name: "🌐 Pagina", value: `[protezionecivile.gov.it](${pageUrl})` }
    )
    .setFooter({ text: "Fonte: Dipartimento della Protezione Civile" })
    .setTimestamp(new Date());
  if (imgUrl) e.setImage(imgUrl);
  return e;
}

async function checkAndPost(client, pageUrl, channelId, key) {
  try {
    const html = await fetchHtml(pageUrl);
    const pdf = findLatestPdf(html);
    if (!pdf) { console.log(key + ": nessun PDF trovato"); return; }
    if (lastPosted[key] === pdf) return;
    const img = findLatestImage(html);
    const ch = await client.channels.fetch(channelId);
    await ch.send({ embeds: [buildEmbed(key, pdf, img, pageUrl)] });
    lastPosted[key] = pdf;
    console.log("Posted " + key + ": " + pdf);
  } catch (e) {
    console.error(key + " error:", e.message);
  }
}

async function pollAll(client) {
  await checkAndPost(client, PAGE_VIG, CH_VIG, "vig");
  await checkAndPost(client, PAGE_CRI, CH_CRI, "cri");
}

async function primeLatest() {
  try {
    const [hv, hc] = await Promise.all([fetchHtml(PAGE_VIG), fetchHtml(PAGE_CRI)]);
    lastPosted.vig = findLatestPdf(hv);
    lastPosted.cri = findLatestPdf(hc);
    console.log("Inizializzato. vig=" + (lastPosted.vig ? "OK" : "—") + " cri=" + (lastPosted.cri ? "OK" : "—"));
  } catch (e) {
    console.error("prime error:", e.message);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log("Logged in as " + client.user.tag);
  await primeLatest();
  try {
    const ch = await client.channels.fetch(CH_VIG);
    await ch.send({
      embeds: [new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("🌍 Monitoraggio Meteo Italia attivo")
        .setDescription(`Controllo bollettini Protezione Civile ogni ${INTERVAL / 60000} min.\n\n**Fonti monitorate:**\n• [Vigilanza Meteorologica](${PAGE_VIG})\n• [Criticità Meteo-Idro](${PAGE_CRI})`)
        .setTimestamp(new Date())]
    });
  } catch (e) { console.error("startup msg:", e.message); }
  setInterval(() => pollAll(client), INTERVAL);
});

client.login(T);
