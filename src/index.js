import { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } from "discord.js";
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

const PAGE_VIG = "https://mappe.protezionecivile.gov.it/it/mappe-rischi/bollettino-di-vigilanza/";
const PAGE_CRI = "https://mappe.protezionecivile.gov.it/it/mappe-rischi/bollettino-di-criticita/";
const DATA_VIG = "https://mappe.protezionecivile.gov.it/page-data/it/mappe-rischi/bollettino-di-vigilanza/page-data.json";
const DATA_CRI = "https://mappe.protezionecivile.gov.it/page-data/it/mappe-rischi/bollettino-di-criticita/page-data.json";
const UA = "meteo-italia-bot/1.0";

const lastPosted = { vig: null, cri: null };

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

function stripHtml(s) {
  if (!s) return "";
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?strong>/gi, "**")
    .replace(/<\/?b>/gi, "**")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function extractNode(json) {
  const n = json?.result?.data?.node;
  if (!n) return null;
  return {
    id: n.field_data_bollettino || n.drupal_internal__nid,
    title: n.title || n.field_titolo_esteso || "Bollettino",
    today: stripHtml(n.field_descrizione_today?.value || n.field_descrizione_today?.processed),
    tomorrow: stripHtml(n.field_descrizione_tomorrow?.value || n.field_descrizione_tomorrow?.processed),
    aftertomorrow: stripHtml(n.field_descrizione_after_tomorrow?.value || n.field_descrizione_after_tomorrow?.processed),
    mapToday: n.field_mappa_today?.uri,
    mapTomorrow: n.field_mappa_tomorrow?.uri,
    mapAfter: n.field_mappa_after_tomorrow?.uri,
    archive: n.field_link_esterni?.[0]?.uri
  };
}

function buildBollettinoEmbed(kind, node, pageUrl) {
  const isVig = kind === "vig";
  const e = new EmbedBuilder()
    .setColor(isVig ? 0x1e88e5 : 0xff6f00)
    .setTitle((isVig ? "🌦️ " : "⚠️ ") + node.title)
    .setURL(pageUrl)
    .setDescription("Nuovo bollettino rilasciato dal Dipartimento della Protezione Civile.");
  if (node.today) e.addFields({ name: "📅 Oggi", value: clip(node.today, 1000) });
  if (node.tomorrow) e.addFields({ name: "📅 Domani", value: clip(node.tomorrow, 1000) });
  if (node.aftertomorrow) e.addFields({ name: "📅 Dopodomani", value: clip(node.aftertomorrow, 1000) });
  const links = [];
  if (node.mapToday) links.push(`[Mappa oggi](${node.mapToday})`);
  if (node.mapTomorrow) links.push(`[Mappa domani](${node.mapTomorrow})`);
  if (node.mapAfter) links.push(`[Mappa dopodomani](${node.mapAfter})`);
  if (links.length) e.addFields({ name: "🗺️ Mappe interattive", value: links.join(" • ") });
  const refs = [`[Pagina ufficiale](${pageUrl})`];
  if (node.archive) refs.push(`[Archivio storico](${node.archive})`);
  e.addFields({ name: "🌐 Riferimenti", value: refs.join(" • ") });
  e.setFooter({ text: "Fonte: Dipartimento della Protezione Civile" }).setTimestamp(new Date());
  return e;
}

async function checkAndPost(client, dataUrl, pageUrl, channelId, key) {
  try {
    const j = await fetchJson(dataUrl);
    const node = extractNode(j);
    if (!node) { console.log(key + ": dati non disponibili"); return; }
    if (lastPosted[key] === node.id) return;
    const ch = await client.channels.fetch(channelId);
    await ch.send({ embeds: [buildBollettinoEmbed(key, node, pageUrl)] });
    lastPosted[key] = node.id;
    console.log("Posted " + key + ": " + node.id);
  } catch (e) {
    console.error(key + " error:", e.message);
  }
}

async function pollAll(client) {
  await checkAndPost(client, DATA_VIG, PAGE_VIG, CH_VIG, "vig");
  await checkAndPost(client, DATA_CRI, PAGE_CRI, CH_CRI, "cri");
}

async function primeLatest() {
  try {
    const [jv, jc] = await Promise.all([fetchJson(DATA_VIG), fetchJson(DATA_CRI)]);
    lastPosted.vig = extractNode(jv)?.id || null;
    lastPosted.cri = extractNode(jc)?.id || null;
    console.log("Inizializzato. vig=" + (lastPosted.vig || "—") + " cri=" + (lastPosted.cri || "—"));
  } catch (e) { console.error("prime error:", e.message); }
}

const WMO = {
  0:{d:"Sereno",e:"☀️"},1:{d:"Prevalentemente sereno",e:"🌤️"},2:{d:"Parzialmente nuvoloso",e:"⛅"},3:{d:"Coperto",e:"☁️"},
  45:{d:"Nebbia",e:"🌫️"},48:{d:"Nebbia con brina",e:"🌫️"},
  51:{d:"Pioviggine leggera",e:"🌦️"},53:{d:"Pioviggine moderata",e:"🌦️"},55:{d:"Pioviggine intensa",e:"🌧️"},
  56:{d:"Pioviggine gelata leggera",e:"🌧️"},57:{d:"Pioviggine gelata intensa",e:"🌧️"},
  61:{d:"Pioggia leggera",e:"🌦️"},63:{d:"Pioggia moderata",e:"🌧️"},65:{d:"Pioggia intensa",e:"🌧️"},
  66:{d:"Pioggia gelata leggera",e:"🌧️"},67:{d:"Pioggia gelata intensa",e:"🌧️"},
  71:{d:"Neve leggera",e:"🌨️"},73:{d:"Neve moderata",e:"🌨️"},75:{d:"Neve intensa",e:"❄️"},77:{d:"Granuli di neve",e:"🌨️"},
  80:{d:"Rovesci leggeri",e:"🌦️"},81:{d:"Rovesci moderati",e:"🌧️"},82:{d:"Rovesci violenti",e:"⛈️"},
  85:{d:"Rovesci di neve leggeri",e:"🌨️"},86:{d:"Rovesci di neve intensi",e:"❄️"},
  95:{d:"Temporale",e:"⛈️"},96:{d:"Temporale con grandine leggera",e:"⛈️"},99:{d:"Temporale con grandine forte",e:"⛈️"}
};

function wmoInfo(code) { return WMO[code] || { d: "Condizioni sconosciute", e: "🌡️" }; }

function windDir(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"];
  return dirs[Math.round(deg / 22.5) % 16];
}

async function geocode(name) {
  const url = "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(name) + "&count=1&language=it&format=json";
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Geocoding HTTP " + r.status);
  const j = await r.json();
  if (!j.results || !j.results.length) return null;
  return j.results[0];
}

async function getCurrentWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    timezone: "Europe/Rome", forecast_days: "1"
  });
  const r = await fetch("https://api.open-meteo.com/v1/forecast?" + params, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Weather HTTP " + r.status);
  return r.json();
}

function buildMeteoEmbed(place, w) {
  const c = w.current, d = w.daily;
  const info = wmoInfo(c.weather_code);
  const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const mapUrl = `https://www.google.com/maps?q=${place.latitude},${place.longitude}`;
  return new EmbedBuilder()
    .setColor(c.is_day ? 0x42a5f5 : 0x303f9f)
    .setTitle(`${info.e} Meteo a ${place.name}`).setURL(mapUrl)
    .setDescription(`**${info.d}**\n${placeName}`)
    .addFields(
      { name: "🌡️ Temperatura", value: `${c.temperature_2m.toFixed(1)} °C`, inline: true },
      { name: "🤔 Percepita", value: `${c.apparent_temperature.toFixed(1)} °C`, inline: true },
      { name: "💧 Umidità", value: `${c.relative_humidity_2m}%`, inline: true },
      { name: "🌬️ Vento", value: `${c.wind_speed_10m.toFixed(1)} km/h ${windDir(c.wind_direction_10m)}`, inline: true },
      { name: "💨 Raffiche", value: `${c.wind_gusts_10m.toFixed(1)} km/h`, inline: true },
      { name: "☁️ Nuvolosità", value: `${c.cloud_cover}%`, inline: true },
      { name: "🌧️ Precipitazioni", value: `${c.precipitation} mm`, inline: true },
      { name: "📊 Pressione", value: `${c.pressure_msl.toFixed(0)} hPa`, inline: true },
      { name: "📅 Oggi", value: `Min ${d.temperature_2m_min[0].toFixed(1)}° / Max ${d.temperature_2m_max[0].toFixed(1)}°\nPioggia: ${d.precipitation_sum[0]} mm`, inline: false }
    )
    .setFooter({ text: "Fonte: Open-Meteo • " + (c.is_day ? "giorno" : "notte") })
    .setTimestamp(new Date(c.time));
}

async function handleMeteo(interaction) {
  const posto = interaction.options.getString("posto", true);
  await interaction.deferReply();
  try {
    const place = await geocode(posto);
    if (!place) { await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xe53935).setTitle("❌ Località non trovata").setDescription(`Non ho trovato \`${posto}\`.`)] }); return; }
    const w = await getCurrentWeather(place.latitude, place.longitude);
    await interaction.editReply({ embeds: [buildMeteoEmbed(place, w)] });
  } catch (e) {
    console.error("/meteo error:", e.message);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xe53935).setTitle("❌ Errore").setDescription("Errore: " + e.message)] });
  }
}

async function getForecast(lat, lon, days = 5) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    timezone: "Europe/Rome", forecast_days: String(days)
  });
  const r = await fetch("https://api.open-meteo.com/v1/forecast?" + params, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Forecast HTTP " + r.status);
  return r.json();
}

function buildForecastEmbed(place, w) {
  const d = w.daily;
  const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const mapUrl = `https://www.google.com
