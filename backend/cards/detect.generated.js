//#region src/components/overlayCards/detectSpecialContent.ts
var num = (s) => parseFloat(s.replace(/,/g, ""));
/** Drops undefined fields (recursively for plain objects) so cards can rely on presence. */
function compact(obj) {
	if (Array.isArray(obj)) return obj.map(compact);
	if (obj && typeof obj === "object") {
		const out = {};
		for (const [k, v] of Object.entries(obj)) if (v !== void 0) out[k] = compact(v);
		return out;
	}
	return obj;
}
var firstMatch = (text, ...patterns) => {
	for (const p of patterns) {
		const m = text.match(p);
		if (m) return m;
	}
	return null;
};
var JSON_TYPES = [
	"weather",
	"finance",
	"flight",
	"system",
	"task_roadmap",
	"media_audio",
	"translation",
	"chart",
	"sports",
	"recipe",
	"wallet",
	"business_dashboard"
];
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** Minimum fields a card needs to be meaningful. */
function hasCoreFields(type, d) {
	if (!d || typeof d !== "object") return false;
	switch (type) {
		case "weather": return isNum(d.temp);
		case "finance": return typeof d.symbol === "string" && isNum(d.price);
		case "flight": return typeof d.flightNumber === "string" && !!d.origin?.code && !!d.destination?.code;
		case "system": return [
			"cpuUsage",
			"ramUsedGB",
			"diskUsedGB",
			"gpuUsage"
		].some((k) => isNum(d[k]));
		case "task_roadmap": return Array.isArray(d.tasks) && d.tasks.length > 0;
		case "media_audio": return typeof d.title === "string";
		case "translation": return typeof d.translatedText === "string";
		case "chart": return Array.isArray(d.labels) && Array.isArray(d.datasets) && d.datasets.length > 0;
		case "sports": return isNum(d.teamA?.score) && isNum(d.teamB?.score);
		case "recipe": return Array.isArray(d.ingredients) && d.ingredients.length > 0;
		case "wallet": return typeof d.address === "string";
		case "business_dashboard": return Array.isArray(d.businesses) && (d.businesses.length > 0 || d.empty === true);
		default: return false;
	}
}
function detectJson(text) {
	const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/^(\{[\s\S]*\})$/);
	if (!m) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(m[1]);
	} catch {
		return;
	}
	const type = typeof parsed?.type === "string" ? parsed.type.toLowerCase() : "";
	if (!JSON_TYPES.includes(type)) return void 0;
	const data = parsed.data || parsed;
	if (!hasCoreFields(type, data)) return null;
	return {
		type,
		data,
		summaryText: parsed.summary || parsed.description
	};
}
/** The text after the first `keyword` match, `span` characters long ('' if absent). */
function after(text, keyword, span = 260) {
	const m = keyword.exec(text);
	return m ? text.slice(m.index, m.index + span) : "";
}
var GB = String.raw`(\d+(?:[.,]\d+)?)\s*(TB|To|GB|Go|GiB|MB|Mo)\b`;
var toGB = (v, unit) => {
	const n = localeNumber(v) ?? 0;
	return /^t/i.test(unit) ? n * 1e3 : /^m/i.test(unit) ? Math.round(n / 1e3 * 10) / 10 : n;
};
/** "17 GB in use out of 18 GB", "419 Go sur 460 Go", "8/16 GB", or "total 18 Go" + "17 Go utilisés". */
function usedOfTotal(section) {
	const pair = section.match(new RegExp(String.raw`~?${GB}\s*(?:in use|used|utilis[ée]s?|occup[ée]s?|usados?|usati)?\s*(?:out of|of|sur|/|de|su)\s*~?${GB}`, "iu"));
	if (pair) return {
		used: toGB(pair[1], pair[2]),
		total: toGB(pair[3], pair[4])
	};
	const total = section.match(new RegExp(String.raw`(?:total|capacit[ée](?: totale)?|capacity|size|taille)[^\d\n]{0,24}${GB}`, "iu"));
	const used = section.match(new RegExp(String.raw`~?${GB}\s*(?:in use|used|utilis[ée]s?|occup[ée]s?|usados?|usati)`, "iu"));
	if (total && used) return {
		used: toGB(used[1], used[2]),
		total: toGB(total[1], total[2])
	};
}
function detectSystem(text) {
	if (!words("system diagnostics|system status|hardware|telemetry|diagnostics|cpu|gpu|ram|memory|processeur|mémoire|m[ée]moire vive|processador|memória|procesador|memoria").test(text)) return void 0;
	const cpu = after(text, /\b(?:cpu|processeur|processor|processador|procesador)\b/i).match(/(\d+(?:[.,]\d+)?)\s*%/);
	const cpuTemp = text.match(/\b(?:cpu\s*)?temp(?:erature|érature)?[^.\d]{0,12}?(\d+(?:\.\d+)?)\s*°\s*C\b/i);
	const ram = usedOfTotal(after(text, /\b(?:ram|memory|m[ée]moire|memória|memoria)\b/i, 320));
	const disk = usedOfTotal(after(text, /\b(?:disk|disque|storage|stockage|ssd|nvme|disco|armazenamento|almacenamiento)\b/i, 360));
	const gpu = after(text, /\bgpu\b/i, 160).match(/(\d+(?:[.,]\d+)?)\s*%/);
	const gpuTemp = text.match(/\bgpu\s*temp(?:erature)?[^.\d]{0,8}?(\d+(?:\.\d+)?)\s*°\s*C\b/i);
	const cores = text.match(/(\d+)[- ](?:core|cœurs?|coeurs?|núcleos)\b/i);
	const data = compact({
		cpuUsage: cpu ? localeNumber(cpu[1]) : void 0,
		cpuTemp: cpuTemp ? num(cpuTemp[1]) : void 0,
		cpuCores: cores ? parseInt(cores[1], 10) : void 0,
		ramUsedGB: ram?.used,
		ramTotalGB: ram?.total,
		diskUsedGB: disk?.used,
		diskTotalGB: disk?.total,
		gpuUsage: gpu ? localeNumber(gpu[1]) : void 0,
		gpuTemp: gpuTemp ? num(gpuTemp[1]) : void 0
	});
	return [
		data.cpuUsage,
		data.ramUsedGB,
		data.diskUsedGB,
		data.gpuUsage
	].filter((v) => v !== void 0).length >= 2 ? {
		type: "system",
		data
	} : void 0;
}
function detectWallet(text) {
	const eth = text.match(/\b(0x[a-fA-F0-9]{40})\b/);
	const sol = /\bsolana\b/i.test(text) ? text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/) : null;
	const walletWords = /\b(wallet|portfolio|holdings|token balance|tokens held|vault)\b/i.test(text);
	if (!eth && !sol && !walletWords) return void 0;
	const total = text.match(/\btotal(?:\s*(?:portfolio\s*)?value)?(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i) || text.match(/\b(?:balance|worth)(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i);
	const tokens = [];
	const seen = /* @__PURE__ */ new Set();
	const re = /([\d,]+(?:\.\d+)?)\s+([A-Z]{2,6})\b(?:\s*\(\s*\$\s*([\d,]+(?:\.\d+)?)\s*\))?/g;
	let m;
	while (m = re.exec(text)) {
		const symbol = m[2];
		if (seen.has(symbol) || [
			"GB",
			"TB",
			"MB",
			"USD",
			"AM",
			"PM"
		].includes(symbol)) continue;
		seen.add(symbol);
		tokens.push(compact({
			symbol,
			balance: num(m[1]),
			valueUSD: m[3] ? num(m[3]) : void 0
		}));
	}
	const address = eth?.[1] ?? sol?.[1];
	if (!address) return void 0;
	if (!total && tokens.length === 0 && !walletWords) return void 0;
	return {
		type: "wallet",
		data: compact({
			address,
			totalValueUSD: total ? num(total[1]) : void 0,
			networks: [],
			tokens: tokens.length ? tokens : void 0
		})
	};
}
/** A case-insensitive Unicode regex whose alternatives must be whole words. */
var words = (alternatives, flags = "iu") => new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})(?![\\p{L}])`, flags);
var CONDITIONS = [
	[
		words("partly cloudy|partiellement nuageux|parcialmente nublado|partiellement couvert"),
		"Partly cloudy",
		"cloudy"
	],
	[
		words("mostly cloudy|plut[ôo]t nuageux|majoritariamente nublado|mayormente nublado"),
		"Mostly cloudy",
		"cloudy"
	],
	[
		words("overcast|couvert|encoberto|cubierto"),
		"Overcast",
		"cloudy"
	],
	[
		words("cloudy|nuageux|nublado|nuvens"),
		"Cloudy",
		"cloudy"
	],
	[
		words("thunder(?:storms?)?|lightning|orages?|orageux|trovoadas?|tempestades?|tormentas?"),
		"Thunderstorms",
		"thunderstorm"
	],
	[
		words("heavy rain|downpours?|fortes? pluies?|chuva forte|lluvia fuerte|aguaceros?"),
		"Heavy rain",
		"rain"
	],
	[
		words("light rain|pluie faible|chuva fraca|lluvia ligera"),
		"Light rain",
		"rain"
	],
	[
		words("drizzle|bruine|chuvisco|garoa|llovizna"),
		"Drizzle",
		"rain"
	],
	[
		/(?<![\p{L}])(?:showers?|averses?|aguaceiros|pancadas de chuva|chubascos?)(?![\p{L}])(?!\s*chance)/iu,
		"Showers",
		"rain"
	],
	[
		/(?<![\p{L}])(?:rain(?:y|ing)?|pluie|pluvieux|chuva|chuvoso|lluvia|lluvioso)(?![\p{L}])(?!\s*chance)(?<!chance of rain)/iu,
		"Rain",
		"rain"
	],
	[
		words("snow(?:ing|y|fall)?|neige|neve|nieve"),
		"Snow",
		"snow"
	],
	[
		words("fog(?:gy)?|mist(?:y)?|brouillard|brume|nevoeiro|neblina|niebla"),
		"Fog",
		"fog"
	],
	[
		words("sunny|ensoleill[ée]e?s?|ensolarado|soleado"),
		"Sunny",
		"sunny"
	],
	[
		words("clear(?:\\s+sk(?:y|ies))?|ciel (?:dégagé|clair)|c[ée]u limpo|cielo despejado|despejado|dégagé"),
		"Clear",
		"sunny"
	]
];
var WEATHER_WORDS = words("weather|forecast|temperatures?|humidity|degrees|météo|prévisions?|températures?|humidité|degrés|tempo|previsão|temperaturas?|umidade|humidade|graus|clima|pronóstico|humedad|grados");
var TOMORROW = words("tomorrow|demain|amanhã|mañana|domani");
var DAY_AFTER = words("day after tomorrow|après-demain|apres-demain|depois de amanhã|pasado mañana|dopodomani");
/** The day an answer is about: 1 = tomorrow, 2 = the day after; undefined = today / now. */
function forecastDayOf(text) {
	const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
	const lead = sentences.find((s) => /-?\d+(?:\.\d+)?\s*\**\s*°/.test(s)) ?? sentences[0] ?? "";
	for (const s of [lead, sentences[0] ?? ""]) {
		if (DAY_AFTER.test(s)) return 2;
		if (TOMORROW.test(s.replace(DAY_AFTER, ""))) return 1;
	}
}
var RANGE = /(?:between|entre|from|de)\s+(-?\d+(?:\.\d+)?)\s*°?\s*[CF]?\s*(?:and|to|et|à|a|e|y)\s+(-?\d+(?:\.\d+)?)\s*°/iu;
/** The condition mentioned first describes "now"; later mentions (e.g. rain chance) don't override it. */
function currentCondition(text) {
	let best = null;
	for (const [re, label, code] of CONDITIONS) {
		const m = re.exec(text);
		if (!m) continue;
		if (!best || m.index < best.index || m.index === best.index && m[0].length > best.length) best = {
			index: m.index,
			length: m[0].length,
			label,
			code
		};
	}
	return best;
}
function detectWeather(text) {
	if (!WEATHER_WORDS.test(text)) return void 0;
	const t = text.match(/(-?\d+(?:\.\d+)?)\s*°\s*([CF])?\b/i);
	if (!t) return void 0;
	const cityM = text.match(/\b(?:weather|forecast)\s+(?:in|for)\s+([\p{L}][\p{L}' -]*?)(?=\s+(?:today|tomorrow|is|right now|currently|this)\b|\s*[:\n.,]|$)/iu);
	const spokenCityM = cityM ? null : text.match(/\b(?:[Rr]ight now |[Cc]urrently |[Tt]oday )?[Ii]n\s+(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)*)\s*,\s*(?:it|the|there|expect)\b/u) ?? text.match(/(?<![\p{L}])(?:[àÀ]|[Ee][mn]|[Nn][oa])\s+(\p{Lu}[\p{L}'-]+(?:[ -]\p{Lu}[\p{L}'-]+)*)\s*,/u);
	const cityRaw = cityM?.[1] ?? spokenCityM?.[1];
	const city = cityRaw && /^\p{Lu}/u.test(cityRaw) ? cityRaw.trim() : void 0;
	const cond = currentCondition(text);
	const highRe = /(?:high|m[aá]x(?:imum|imale?s?|ima)?)(?:\s+(?:of|de))?\s*:?\s*(-?\d+(?:\.\d+)?)\s*°/iu;
	const lowRe = /(?:low|m[ií]n(?:imum|imale?s?|ima)?)(?:\s+(?:of|de))?\s*:?\s*(-?\d+(?:\.\d+)?)\s*°/iu;
	const sentences = text.split(/(?<=[.!?])\s+|\n+/);
	let high;
	let low;
	const tomorrow = {};
	for (const sentence of sentences) {
		const range = sentence.match(RANGE);
		const h = sentence.match(highRe)?.[1] ?? range?.[2];
		const l = sentence.match(lowRe)?.[1] ?? range?.[1];
		if (TOMORROW.test(sentence)) {
			if (h !== void 0 && tomorrow.high === void 0) tomorrow.high = num(h);
			if (l !== void 0 && tomorrow.low === void 0) tomorrow.low = num(l);
		} else {
			if (h !== void 0) high ??= num(h);
			if (l !== void 0) low ??= num(l);
		}
	}
	const feels = text.match(/(?:feels like|ressenti(?:e)?(?:\s+de)?|sensação térmica(?:\s+de)?|sensación térmica(?:\s+de)?)\s*(-?\d+(?:\.\d+)?)\s*°/iu);
	const humidity = text.match(/(?:humidity|humidité|umidade|humidade|humedad)[^.\d]{0,20}?(\d+)\s*%/iu);
	const wind = text.match(/(?<![\p{L}])(?:wind|vent|vento|viento)(?:\s*speed)?[^.\d]{0,20}?(\d+(?:\.\d+)?)\s*(km\/h|kph|mph|m\/s|knots|nœuds)/iu);
	const pop = firstMatch(text, /(\d+)\s*%\s*(?:rain chance|chance of (?:rain|showers|precipitation)|precipitation|de (?:risque de )?pluie|de chances? de pluie|de (?:probabilidade de )?chuva|de (?:probabilidad de )?lluvia)/iu, /(?:rain chance|chance of (?:rain|showers)|precipitation|risque de pluie|probabilit[ée] de pluie|probabilidade de chuva|probabilidad de lluvia)[^.\d]{0,12}?(\d+)\s*%/iu);
	const uv = text.match(/\buv(?:\s*index)?[^.\d]{0,10}?(\d+)/i);
	return {
		type: "weather",
		data: compact({
			city,
			temp: num(t[1]),
			tempUnit: t[2] ? t[2].toUpperCase() : void 0,
			condition: cond?.label,
			conditionCode: cond?.code,
			high,
			low,
			feelsLike: feels ? num(feels[1]) : void 0,
			humidity: humidity ? parseInt(humidity[1], 10) : void 0,
			windSpeed: wind ? num(wind[1]) : void 0,
			windUnit: wind?.[2],
			precipitationChance: pop ? parseInt(pop[1], 10) : void 0,
			uvIndex: uv ? parseInt(uv[1], 10) : void 0,
			dailyForecast: tomorrow.high !== void 0 || tomorrow.low !== void 0 ? [{
				day: "Tomorrow",
				...tomorrow
			}] : void 0,
			forecastDay: forecastDayOf(text)
		})
	};
}
var KNOWN_TICKERS = /\b(BTC|ETH|SOL|AAPL|NVDA|TSLA|AMZN|MSFT|GOOGL|META|SPY|QQQ)\b/;
var NAMED_COINS = [
	[
		words("bitcoin"),
		"BTC",
		"Bitcoin"
	],
	[
		words("ethereum|ether"),
		"ETH",
		"Ethereum"
	],
	[
		words("solana"),
		"SOL",
		"Solana"
	]
];
var MARKET_WORDS = words("stock|shares?|crypto|cryptocurrency|market|trading|trades|price|volume|24h|bullish|bearish|up|down|cours|prix|bourse|action|cote|cotation|march[ée]|hausse|baisse|cryptomonnaie|euros?|dollars?|preço|cotação|bolsa|alta|queda|precio|cotización|subida|bajada|prezzo|borsa|rialzo|ribasso");
/** "85 736", "76 151,50", "1,234.56", "1.234,56", "231,45" → a number (any locale). */
function localeNumber(raw) {
	let s = raw.replace(/[\s  ']/g, "");
	const comma = s.lastIndexOf(",");
	const dot = s.lastIndexOf(".");
	if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
	else if (comma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
	else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, "");
	const n = Number(s);
	return Number.isFinite(n) ? n : void 0;
}
var AMOUNT = String.raw`\d{1,3}(?:[   .,']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
var MONEY_BEFORE = new RegExp(String.raw`(?<![+\-−]\s?)(US\$|\$|€|£|USD|EUR|GBP)\s?(${AMOUNT})(?![\d.,]*\s*[TBMK]\b)`, "giu");
var MONEY_AFTER = new RegExp(String.raw`(?<![\d+\-−.,])(${AMOUNT})\s?(\$|€|£|USD|EUR|GBP|dollars?|euros?)(?![\p{L}])`, "giu");
var currencyCode = (c) => /€|eur/i.test(c) ? "EUR" : /£|gbp/i.test(c) ? "GBP" : "USD";
function moneyAmounts(text) {
	const out = [];
	for (const m of text.matchAll(MONEY_BEFORE)) {
		const value = localeNumber(m[2]);
		if (value !== void 0) out.push({
			value,
			currency: currencyCode(m[1]),
			index: m.index ?? 0
		});
	}
	for (const m of text.matchAll(MONEY_AFTER)) {
		const value = localeNumber(m[1]);
		if (value !== void 0) out.push({
			value,
			currency: currencyCode(m[2]),
			index: m.index ?? 0
		});
	}
	return out.sort((a, b) => a.index - b.index);
}
var SIGNED_PCT = /([+\-−])\s?(\d+(?:[.,]\d+)?)\s*%/;
var WORDED_PCT = /(up|rose|gained|climbed|jumped|higher|down|fell|dropped|lost|slid|lower|hausse|baisse|alta|queda|subida|bajada|alza|baja|rialzo|ribasso|calo)\s+(?:by\s+|de\s+|di\s+)?(\d+(?:[.,]\d+)?)\s*%/iu;
var FALLING = /^(down|fell|dropped|lost|slid|lower|baisse|queda|bajada|baja|ribasso|calo)$/i;
function percentChange(text) {
	const signed = text.match(SIGNED_PCT);
	if (signed) return (signed[1] === "+" ? 1 : -1) * (localeNumber(signed[2]) ?? 0);
	const worded = text.match(WORDED_PCT);
	if (worded) return (FALLING.test(worded[1]) ? -1 : 1) * (localeNumber(worded[2]) ?? 0);
}
function detectFinance(text) {
	const tickerM = firstMatch(text, /\(\s*\$?([A-Z]{2,6})\s*\)/, /\$([A-Z]{2,6})\b/, KNOWN_TICKERS);
	const named = tickerM ? void 0 : NAMED_COINS.find(([re]) => re.test(text));
	if (!tickerM && !named) return void 0;
	const symbol = tickerM ? tickerM[1] : named[1];
	const amounts = moneyAmounts(text);
	const priced = amounts.find((a) => a.currency === "USD") ?? amounts[0];
	if (!priced) return void 0;
	if (!MARKET_WORDS.test(text) && !text.includes("%")) return void 0;
	const lineStart = text.lastIndexOf("\n", priced.index) + 1;
	const lineEnd = text.indexOf("\n", priced.index);
	const changePercent = percentChange(text.slice(lineStart, lineEnd < 0 ? void 0 : lineEnd)) ?? percentChange(text);
	const nameM = text.match(new RegExp(`((?:[A-Z][\\w&.\\-]*\\s?){1,4})\\(\\s*\\$?${symbol}\\s*\\)`));
	const changeAbs = text.match(/([+\-−])\s?\$\s*([\d,]+(?:\.\d+)?)/);
	const cap = text.match(/\bmarket cap(?:itali[sz]ation)?(?:\s*of)?[:\s]*(\$\s*[\d.,]+\s*[TBMK])\b/i);
	const vol = text.match(/\bvolume(?:\s*of)?[:\s]*\$?\s*([\d.,]+\s*[TBMK])\b/i);
	const w52h = text.match(/\b52[- ]week high(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i);
	const w52l = text.match(/\b52[- ]week low(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i);
	const h24 = text.match(/\b(?:24h|day'?s?|daily) high(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i);
	const l24 = text.match(/\b(?:24h|day'?s?|daily) low(?:\s*of)?[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i);
	return {
		type: "finance",
		data: compact({
			symbol,
			name: nameM ? nameM[1].trim() : named?.[2],
			price: priced.value,
			currency: priced.currency !== "USD" ? priced.currency : void 0,
			change: changeAbs ? (changeAbs[1] === "+" ? 1 : -1) * num(changeAbs[2]) : void 0,
			changePercent,
			marketCap: cap ? cap[1].replace(/\s+/g, "") : void 0,
			volume24h: vol ? vol[1].replace(/\s+/g, "") : void 0,
			week52High: w52h ? num(w52h[1]) : void 0,
			week52Low: w52l ? num(w52l[1]) : void 0,
			high24h: h24 ? num(h24[1]) : void 0,
			low24h: l24 ? num(l24[1]) : void 0
		})
	};
}
var AIRLINES = [
	"British Airways",
	"Delta Air Lines",
	"United Airlines",
	"American Airlines",
	"Air France",
	"TAP Air Portugal",
	"Qatar Airways",
	"Turkish Airlines",
	"Singapore Airlines",
	"Cathay Pacific",
	"Japan Airlines",
	"Air Canada",
	"ITA Airways",
	"Alaska Airlines",
	"Wizz Air",
	"Lufthansa",
	"KLM",
	"Emirates",
	"Ryanair",
	"easyJet",
	"Iberia",
	"Vueling",
	"JetBlue",
	"Qantas",
	"Etihad",
	"Southwest"
];
function detectFlight(text) {
	if (!words("flight|airline|departure|arrival|gate|terminal|airport|boarding|landed|departed|vol|d[ée]part|arriv[ée]e|a[ée]roport|embarquement|atterri|d[ée]coll[ée]|voo|vuelo|volo").test(text)) return void 0;
	const fn = text.match(/\b((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4})\b/);
	const route = firstMatch(text, /\bfrom\s+([A-Z]{3})\s+to\s+([A-Z]{3})\b/, /\b([A-Z]{3})\s*(?:→|->|–|—)\s*([A-Z]{3})\b/);
	const inParens = [...new Set([...text.matchAll(/\(([A-Z]{3})(?=[\s,;)–-])/g)].map((m) => m[1]))];
	const codes = route ? [route[1], route[2]] : inParens.length >= 2 ? inParens.slice(0, 2) : void 0;
	if (!fn || !codes) return void 0;
	const [originCode, destCode] = codes;
	const airline = AIRLINES.find((a) => new RegExp(`\\b${a.replace(/ /g, "\\s+")}\\b`, "i").test(text));
	const status = words("cancell?ed|annul[ée]e?|cancelado|cancellato").test(text) ? "CANCELLED" : words("delayed|retard[ée]?|en retard|atrasado|retrasado|in ritardo").test(text) ? "DELAYED" : words("landed|arrived|touched down|atterri|a atterri|arriv[ée] à destination|aterrizó|aterrou|atterrato").test(text) ? "LANDED" : words("boarding|embarquement").test(text) ? "BOARDING" : words("cruising|in flight|en route|airborne|in the air|en vol|em voo|en vuelo|in volo").test(text) ? "IN FLIGHT" : words("on time|à l'heure|à l’heure|selon les horaires|no horário|a tiempo|in orario").test(text) ? "ON TIME" : words("scheduled|prévu|programado|previsto").test(text) ? "SCHEDULED" : void 0;
	const anchors = [];
	const addAnchors = (re, side) => {
		for (const m of text.matchAll(re)) anchors.push({
			index: m.index ?? 0,
			side
		});
	};
	addAnchors(new RegExp(`\\b${originCode}\\b`, "g"), "origin");
	addAnchors(new RegExp(`\\b${destCode}\\b`, "g"), "destination");
	addAnchors(/(?:\bdepart\w*|\btake[- ]?off|\bboarding|d[ée]part|d[ée]coll)/giu, "origin");
	addAnchors(/(?:\bland\w*|\barriv\w*|atterri|touched down)/giu, "destination");
	anchors.sort((a, b) => a.index - b.index);
	const sideAt = (index) => {
		let side = "origin";
		for (const a of anchors) {
			if (a.index > index) break;
			side = a.side;
		}
		return side;
	};
	const place = {
		origin: {},
		destination: {}
	};
	for (const m of text.matchAll(/\bterminal\s+([A-Z]?\d+[A-Z]?)\b/gi)) {
		const side = sideAt(m.index ?? 0);
		place[side].terminal ??= m[1];
	}
	for (const m of text.matchAll(/\bgate\s+([A-Z]?\d+[A-Z]?)\b/gi)) {
		const side = sideAt(m.index ?? 0);
		place[side].gate ??= m[1];
	}
	const TIME = String.raw`(\d{1,2})[:h](\d{2})(?:\s?([AP]M))?`;
	const clock = (m) => m ? `${m[1].padStart(2, "0")}:${m[2]}${m[3] ? ` ${m[3]}` : ""}` : void 0;
	const arrivalM = text.match(new RegExp(String.raw`(?:\bland\w*|\barriv\w*|atterri|touched down)[^\n]*?${TIME}`, "iu"));
	const departureM = text.match(new RegExp(String.raw`(?:\bdepart\w*|d[ée]part|\btake[- ]?off|d[ée]coll\w*)[^\n]*?${TIME}`, "iu"));
	const actualVsPlanned = (section) => {
		if (!section) return void 0;
		const m = text.slice(section.index ?? 0, (section.index ?? 0) + 220).match(new RegExp(String.raw`${TIME}[^\n\d]{0,24}?(?:au lieu de|instead of|\(?scheduled(?: for)?|\(?prévue? (?:à|pour)|em vez de|en lugar de|invece delle?)\s*${TIME}`, "iu"));
		return m ? {
			actual: clock([
				m[0],
				m[1],
				m[2],
				m[3]
			]),
			planned: clock([
				m[0],
				m[4],
				m[5],
				m[6]
			])
		} : void 0;
	};
	const depTimes = actualVsPlanned(departureM);
	const arrTimes = actualVsPlanned(arrivalM);
	const arrival = arrTimes?.actual ?? clock(arrivalM);
	const departure = depTimes?.planned ?? clock(departureM);
	const altitude = text.match(/\b(?:at|altitude(?:\s+of)?)\s+([\d,]{3,})\s*(ft|feet|m)\b/i);
	const speed = text.match(/\bspeed(?:\s+of)?[:\s]*([\d,]+\s*(?:knots|km\/h|mph))/i);
	const progress = text.match(/\b(\d{1,3})\s*%\s*(?:complete|of the way)/i);
	const duration = text.match(/\b(?:duration|flight time)[:\s]*(\d+\s*h(?:\s*\d+\s*m(?:in)?)?|\d+\s*hours?(?:\s*\d+\s*min(?:utes)?)?)/i);
	return {
		type: "flight",
		data: compact({
			flightNumber: fn[1],
			airline,
			status,
			origin: {
				code: originCode,
				...place.origin,
				scheduledTime: departure,
				actualTime: depTimes?.actual
			},
			destination: {
				code: destCode,
				...place.destination,
				estimatedTime: arrival,
				scheduledTime: arrTimes?.planned
			},
			altitude: altitude ? `${altitude[1].replace(/,/g, "")} ${altitude[2] === "feet" ? "ft" : altitude[2]}` : void 0,
			speed: speed?.[1],
			progressPercent: progress ? Math.min(100, parseInt(progress[1], 10)) : void 0,
			duration: duration?.[1]
		})
	};
}
var PLAN_STEP = /^(?:#{1,4}\s+)?(?:\d+[.)]\s+)?(?:étape|etape|step|phase|week|semaine|semana|settimana|jour|day|dia|día|giorno|mois|month|mês|mes|mese|stage|etapa|fase|sprint|milestone|jalon)\s*(\d+)(?:\s*[-–]\s*\d+)?\s*[:.–—-]?\s*(.+)$/iu;
/** A plan written as step headings (≥3), the way agents answer "give me a plan…". */
function detectPlan(text) {
	const steps = text.split("\n").map((l) => l.trim().replace(/\*\*|__/g, "")).filter((l) => /^(?:#{1,4}\s|\d+[.)]\s|[\p{L}])/u.test(l)).map((l) => l.match(PLAN_STEP)).filter((m) => !!m && m[2].trim().length > 1);
	if (steps.length < 3) return void 0;
	const aim = text.match(/\b(?:plan|roadmap|feuille de route|programme|plano|plan de acción|piano)\b[^.:\n]{0,40}?\b(?:pour|to|for|de|para|per)\s+([^.:\n]{3,120})/iu)?.[1]?.trim();
	const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
	return {
		type: "task_roadmap",
		data: compact({
			projectTitle: aim && aim.length <= 40 ? cap(aim) : "Plan",
			description: aim && aim.length > 40 ? cap(aim) : void 0,
			progressPercent: 0,
			tasks: steps.map((m, i) => ({
				id: `step-${i}`,
				title: m[2].replace(/\s*:\s*$/, "").trim(),
				completed: false
			}))
		})
	};
}
function detectTasks(text) {
	const lines = text.split("\n").filter((l) => /^\s*[-*]\s*\[([ xX])\]\s+(.*)/.test(l));
	if (lines.length < 2) return detectPlan(text);
	const tasks = lines.map((line, idx) => {
		const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.*)/);
		let title = m[2].trim();
		const tag = title.match(/\s*(?:\((low|medium|high|urgent)\)|\[(low|medium|high|urgent)\]|!(low|medium|high|urgent))\s*$/i);
		let priority;
		if (tag) {
			priority = (tag[1] || tag[2] || tag[3]).toUpperCase();
			title = title.slice(0, tag.index).trim();
		}
		return compact({
			id: `task-${idx}`,
			title,
			completed: m[1].toLowerCase() === "x",
			priority
		});
	});
	const titleM = firstMatch(text, /^#+\s*(.+)$/m, /^([^\n\-*[].*?):\s*$/m, /\*\*(.+?)\*\*/);
	return {
		type: "task_roadmap",
		data: compact({
			projectTitle: titleM ? titleM[1].replace(/[:#*]/g, "").trim() : void 0,
			progressPercent: Math.round(tasks.filter((t) => t.completed).length / tasks.length * 100),
			tasks
		})
	};
}
var INGREDIENTS_HEAD = /^(?:ingredients?|ingrédients?|ingredientes|ingredienti)\b/i;
var STEPS_HEAD = /^(?:instructions?|steps|directions|method|preparation|préparation|étapes|etapes|recette|modo de preparo|preparo|preparación|instrucciones|procedimento|preparazione)\b/i;
/** "### **Ingrédients (pour 4)** :" → "Ingrédients (pour 4)". */
var headingText = (line) => line.replace(/^#+\s*/, "").replace(/\*\*|__/g, "").replace(/\s*:\s*$/, "").trim();
function detectRecipe(text) {
	if (!words("ingredients?|recipe|recette|ingrédients?|receita|ingredientes|receta|ricetta|ingredienti").test(text)) return void 0;
	const ingredients = [];
	const steps = [];
	let section = "none";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const isHeading = /^#+\s/.test(line) || /^(?:\*\*|__)?[\p{L} ()\d,'’-]{3,60}(?:\*\*|__)?\s*:?\s*$/u.test(line) && !/^[-*•\d]/.test(line);
		const head = headingText(line);
		if (isHeading && INGREDIENTS_HEAD.test(head)) {
			section = "ingredients";
			continue;
		}
		if (isHeading && STEPS_HEAD.test(head)) {
			section = "steps";
			continue;
		}
		if (/^#+\s/.test(line)) {
			section = "none";
			continue;
		}
		const item = line.replace(/^(?:\d+[.)]|[-*•])\s+/, "").replace(/\*\*|__|\*/g, "").trim();
		if (section === "ingredients" && /^[-*•]\s+/.test(line) && item) ingredients.push({ item });
		else if (section === "steps" && /^(?:\d+[.)]|[-*•])\s+/.test(line) && item) steps.push(item);
	}
	if (ingredients.length < 2) return void 0;
	const titleM = firstMatch(text, /\b(?:recipe for|recette (?:de |des |du |d['’])|receita de |receta de |ricetta (?:di |del |della ))([^.,:\n!]{2,40})/iu, /\b(?:an? |une? |la |le )?(?:classic,?\s+|simple,?\s+|easy,?\s+|fresh,?\s+)*([\p{L}][\p{L} -]{2,30}?) recipe\b/iu, /\b(?:recette|recipe|receita|receta|ricetta)\b[^.\n]{0,80}?\b(?:de|for|of|di)\s+(?:(?:une|un|des|la|le|les|some)\s+)?(?:(?:quinzaine|douzaine|dizaine|dozen)\s+(?:de\s+|of\s+)?)?(\p{L}[\p{L}'’-]{2,})/iu, /^#+[ \t]*(?![ \t])(?!ingr|instr|steps|direct|method|pr[ée]par|[ée]tapes)(.+)$/imu);
	const time = (label) => text.match(new RegExp(`${label.source}[^\\d\\n]{0,12}(\\d+\\s*(?:min(?:ute)?s?|h(?:ours?|rs?|eures?)?)\\b)`, "iu"))?.[1];
	const difficulty = text.match(/\b(easy|medium|hard)\b/i)?.[1];
	const servings = firstMatch(text, /\bserves\s*(\d+)/i, /\b(\d+)\s*servings?\b/i, /\bpour (?:environ )?(\d+)(?:\s*(?:à|-)\s*\d+)?\s/iu, /\b(\d+)\s*(?:personnes|parts|portions|porções|porciones|persone)\b/iu);
	return {
		type: "recipe",
		data: compact({
			title: titleM ? titleM[1].replace(/[:#*]/g, "").trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase()) : "Recipe",
			prepTime: time(/\b(?:prep(?:aration)?\s*time|temps de pr[ée]paration|pr[ée]paration|tempo de preparo|tiempo de preparaci[óo]n)/),
			cookTime: time(/\b(?:cook(?:ing)?\s*time|cuisson|temps de cuisson|cozimento|cocci[óo]n|cottura)/),
			difficulty: difficulty ? difficulty[0].toUpperCase() + difficulty.slice(1).toLowerCase() : void 0,
			servings: servings ? parseInt(servings[1], 10) : void 0,
			ingredients,
			steps
		})
	};
}
function detectMedia(text) {
	if (!/\b(now playing|playing|listening to|track|song)\b/i.test(text)) return void 0;
	const title = text.match(/["“]([^"”]+)["”]/);
	if (!title) return void 0;
	const artist = text.slice((title.index ?? 0) + title[0].length).match(/^\s*by\s+(.+?)(?=\s+(?:from|on|off)\b|[,.;\n]|$)/i);
	const album = text.match(/\bfrom the album\s+(.+?)(?=\.\s|\.$|\n|$)/i);
	const duration = text.match(/\b(?:duration|length)[:\s]*(\d{1,2}:\d{2})\b/i);
	const lyricsBlock = text.match(/\blyrics:\s*([\s\S]+)$/i);
	const lyrics = lyricsBlock ? lyricsBlock[1].split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 8).map((line) => ({ text: line })) : void 0;
	return {
		type: "media_audio",
		data: compact({
			title: title[1].trim(),
			artist: artist?.[1].trim(),
			album: album?.[1].trim(),
			duration: duration?.[1],
			lyrics
		})
	};
}
var LEAGUES = [
	"Champions League",
	"Europa League",
	"Conference League",
	"Premier League",
	"La Liga",
	"Serie A",
	"Bundesliga",
	"Ligue 1",
	"Liga Portugal",
	"Primeira Liga",
	"Eredivisie",
	"MLS",
	"NBA",
	"NFL",
	"NHL",
	"MLB",
	"World Cup",
	"FA Cup",
	"Copa del Rey",
	"Taça de Portugal",
	"Copa Libertadores"
];
var TEAM = String.raw`\p{Lu}(?:[\p{L}'’-]|\.(?=\p{L}))*(?:[ \t]+(?:(?:de|du|des|of|the|di|da|do|del|y|&)[ \t]+)?\p{Lu}(?:[\p{L}'’-]|\.(?=\p{L}))*){0,4}`;
var PRONOUN = /^(?:they|he|she|it|ils|elles|il|elle|eles|elas|ellos|ellas|loro)$/i;
var WON_BY = new RegExp(String.raw`(?:won by|remport[ée]e? par|gagn[ée]e? par|vencid[ao] pel[ao]|ganad[ao] por|vint[ao] da(?:l|lla)?)\s+(?:the\s+|le\s+|la\s+|l['’])?(${TEAM})`, "iu");
var ARTICLE = String.raw`(?:(?:the|le|la|les|l['’]|el|o|a|il|lo)\s*)?`;
var SCORE = String.raw`(\d{1,3})\s*[-–—:]\s*(\d{1,3})`;
var WIN = String.raw`(?:won|beat|defeated|edged(?: past)?|thrashed|overcame|s['’]est impos[ée]e?|a battu|a gagn[ée]|a dominé|venceu|derrotou|ganó|venció|ha vinto|ha battuto)`;
var LOSS = String.raw`(?:fell|lost|were beaten|was beaten|went down|s['’]est inclin[ée]e?|a perdu|perdeu|perdió|ha perso)`;
var DRAW = String.raw`(?:drew|tied|a fait match nul|ont fait match nul|empatou|empató|ha pareggiato)`;
var VS = String.raw`(?:against|over|to|with|face (?:à|au)|contre|devant|contra|ante|frente a|a|al|contro)`;
function detectSports(text) {
	if (!words("vs|versus|match|game|score|goals?|ft|ht|full[- ]time|half[- ]time|final|league|cup|won|beat|points|rencontre|but|buts|victoire|défaite|ligue|coupe|jogo|partida|gol|partido|liga|partita|campionato").test(text)) return void 0;
	const league = LEAGUES.find((l) => new RegExp(`\\b${l}\\b`, "i").test(text));
	const status = /\bfull[- ]time\b|\bFT\b/i.test(text) ? "Full time" : /\bhalf[- ]time\b|\bHT\b|mi-temps/i.test(text) ? "Half time" : text.match(/\b(\d{1,3})['’](?!\s*s\b)/)?.[0] ?? (/\bfinal score\b|\bfinal\b/i.test(text) ? "Final" : /\blive\b|en direct/i.test(text) ? "Live" : void 0);
	const clean = (name) => name.replace(/^(?:(?:the|le|la|les|el|o|il|lo)\s+|l['’])/i, "").trim();
	const resolve = (name) => PRONOUN.test(name.trim()) ? text.match(WON_BY)?.[1] ?? name : name;
	const penalties = /on penalties|aux tirs au but|aux penalties|nos p[êe]naltis|en (?:los )?penaltis|ai rigori/i.test(text);
	const result = (a, sa, b, sb, ended) => ({
		type: "sports",
		data: compact({
			league,
			status: penalties ? "Final · penalties" : status ?? (ended ? "Full time" : void 0),
			teamA: {
				name: clean(resolve(a)),
				score: sa
			},
			teamB: {
				name: clean(b),
				score: sb
			}
		})
	});
	const win = text.match(new RegExp(String.raw`(${TEAM})\s+${WIN}\s+(?:par\s+|by\s+|por\s+|per\s+)?${SCORE}\s+${VS}\s+${ARTICLE}(${TEAM})`, "u")) ?? text.match(new RegExp(String.raw`(${TEAM})\s+${WIN}\s+${ARTICLE}(${TEAM})\s+(?:par\s+|by\s+|por\s+|per\s+)?${SCORE}`, "u"));
	if (win) {
		const named = win[2] && !/^\d/.test(win[2]) ? {
			a: win[1],
			b: win[2],
			x: +win[3],
			y: +win[4]
		} : {
			a: win[1],
			b: win[4],
			x: +win[2],
			y: +win[3]
		};
		return result(named.a, Math.max(named.x, named.y), named.b, Math.min(named.x, named.y), true);
	}
	const loss = text.match(new RegExp(String.raw`(${TEAM})\s+${LOSS}\s+${SCORE}\s+${VS}\s+${ARTICLE}(${TEAM})`, "u"));
	if (loss) return result(loss[1], Math.min(+loss[2], +loss[3]), loss[4], Math.max(+loss[2], +loss[3]), true);
	const draw = text.match(new RegExp(String.raw`(${TEAM})\s+${DRAW}\s+${SCORE}\s+${VS}\s+${ARTICLE}(${TEAM})`, "u"));
	if (draw) return result(draw[1], +draw[2], draw[4], +draw[3], true);
	const m = text.match(/(\p{Lu}[\p{L}.'’ ]*?)\s+(\d{1,3})\s*[-–:]\s*(\d{1,3})\s+(\p{Lu}[\p{L}.'’ ]*?)(?=\s*[.,;!\n]|\s+(?:at|in|on|after|with|to)\b|$)/u);
	if (!m) return void 0;
	return result(m[1], parseInt(m[2], 10), m[4], parseInt(m[3], 10), false);
}
var LANGUAGE_NAMES = words("english|anglais|inglês|inglés|inglese|french|français|francês|francés|francese|spanish|espagnol|espanhol|español|spagnolo|portuguese|portugais|português|portugués|portoghese|italian|italien|italiano|german|allemand|alemão|alemán|tedesco|japanese|japonais|japonês|japonés|giapponese|chinese|chinois|chinês|chino|cinese|mandarin|cantonese|korean|coréen|coreano|arabic|arabe|árabe|arabo|russian|russe|russo|ruso|dutch|néerlandais|holandês|neerlandés|olandese|hindi|turkish|turc|turco|greek|grec|grego|griego|greco|polish|polonais|polaco|polacco|swedish|suédois|sueco|svedese");
var TRANSLATE_VERB = /(?:se traduit(?:\s+\p{L}+)?\s+par|(?:is|are)\s+(?:most\s+|usually\s+|simply\s+)?(?:commonly\s+)?translated\s+(?:as|to|into)|translat(?:es|ed)\s+(?:as|to)|se dit|on dit|you(?:'d| would)? say|se diz|traduz-se (?:como|por)|é traduzido como|se traduce(?:\s+\p{L}+)?\s+(?:como|por)|si traduce(?:\s+\p{L}+)?\s+(?:con|come))\s*:?/iu;
var unquote = (t) => t.replace(/^[\s«"“‘'*]+|[\s»"”’'*]+$/g, "").trim();
function detectTranslation(text) {
	const pair = text.match(/\b(?:original|source)\s*(?:\(([^)]+)\))?\s*:\s*([\s\S]+?)\n+\s*(?:translation|translated)\s*(?:\(([^)]+)\))?\s*:\s*([\s\S]+?)\s*$/i);
	if (pair) return {
		type: "translation",
		data: compact({
			sourceLang: pair[1]?.trim(),
			targetLang: pair[3]?.trim(),
			sourceText: pair[2].trim(),
			translatedText: pair[4].trim()
		})
	};
	const inline = text.match(/["“]([^"”]+)["”]\s+in\s+(\p{Lu}\p{L}+)\s+is\s+["“]([^"”]+)["”]/u);
	if (inline) return {
		type: "translation",
		data: {
			sourceText: inline[1],
			targetLang: inline[2],
			translatedText: inline[3]
		}
	};
	const verb = TRANSLATE_VERB.exec(text);
	if (!verb) return void 0;
	const rest = text.slice(verb.index + verb[0].length);
	const first = rest.match(/\*\*([^*\n]{1,160})\*\*|«\s*([^»\n]{1,160})»|"([^"\n]{1,160})"|“([^”\n]{1,160})”/);
	if (!first || (first.index ?? 0) > 240) return void 0;
	const translatedText = unquote(first[1] ?? first[2] ?? first[3] ?? first[4] ?? "");
	if (!translatedText) return void 0;
	const afterTranslation = rest.slice((first.index ?? 0) + first[0].length);
	const phonetic = afterTranslation.match(/^\s*\(\s*\*?([^)*\n]{1,80}?)\*?\s*\)/)?.[1]?.trim();
	const alternatives = [...afterTranslation.matchAll(/\*\*([^*\n]{1,120})\*\*/g)].map((m) => unquote(m[1])).filter((t, i, all) => t && t !== translatedText && all.indexOf(t) === i).slice(0, 4);
	const before = text.slice(0, verb.index);
	const sourceText = [...before.matchAll(/["“«‘']\s*([^"”»’'\n]{2,120}?)\s*["”»’']/g)].map((m) => m[1].trim()).pop();
	const targetLang = (before.match(new RegExp(String.raw`\b(?:in|en|em|al|into|to)\s+(${LANGUAGE_NAMES.source})`, "iu")) ?? text.match(new RegExp(String.raw`\b(?:in|en|em|al|into|to)\s+(${LANGUAGE_NAMES.source})`, "iu")))?.[1];
	return {
		type: "translation",
		data: compact({
			sourceText,
			targetLang,
			translatedText,
			phonetic,
			alternatives: alternatives.length ? alternatives : void 0
		})
	};
}
/** The first number in a table cell, any locale: "66 422 469", "$260.17 billion", "+0,27 %". */
function cellNumber(cell) {
	const m = cell.replace(/\*\*|__/g, "").match(/[-+−]?\s?[$€£]?\s?(\d{1,3}(?:[   .,']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/);
	if (!m) return void 0;
	const n = localeNumber(m[1]);
	return n === void 0 ? void 0 : /^[-−]/.test(m[0].trim()) ? -n : n;
}
function detectChart(text) {
	const rows = text.split("\n").filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"));
	if (rows.length < 4) return void 0;
	const cells = (row) => row.trim().slice(1, -1).split("|").map((c) => c.replace(/\*\*|__/g, "").trim());
	const headers = cells(rows[0]);
	if (headers.length < 2) return void 0;
	const body = rows.slice(1).filter((r) => !/^\|\s*:?-{2,}/.test(r.trim())).map(cells);
	let col = -1;
	let best = 0;
	for (let c = 1; c < headers.length; c++) {
		const count = body.filter((r) => cellNumber(r[c] ?? "") !== void 0).length;
		if (count > best) {
			best = count;
			col = c;
		}
	}
	if (col < 0 || best < 2) return void 0;
	const labels = [];
	const values = [];
	for (const r of body) {
		const v = cellNumber(r[col] ?? "");
		if (!r[0] || v === void 0) continue;
		labels.push(r[0]);
		values.push(v);
	}
	if (values.length < 2) return void 0;
	const yearly = labels.every((l) => /\b(?:19|20)\d{2}\b/.test(l));
	const heading = text.match(/^#+\s*(.+)$/m)?.[1]?.replace(/\*\*|__/g, "").trim();
	return {
		type: "chart",
		data: {
			title: heading && heading.length <= 60 ? heading : headers[col],
			chartType: yearly || values.length > 6 ? "line" : "bar",
			labels,
			datasets: [{
				label: headers[col],
				data: values
			}]
		}
	};
}
/**
* Detects rich result content in an agent's output. Structured JSON wins; otherwise
* conservative text extraction that only returns what is literally stated.
*/
function detectSpecialContent(rawText, _agentName) {
	if (!rawText || typeof rawText !== "string") return null;
	const text = rawText.trim();
	const json = detectJson(text);
	if (json !== void 0) return json;
	const plain = text.replace(/\*\*|__/g, "");
	for (const detector of [
		detectSystem,
		detectWallet,
		detectWeather,
		detectFinance,
		detectFlight,
		detectTasks,
		detectRecipe,
		detectMedia,
		detectSports,
		detectChart
	]) {
		const found = detector(plain);
		if (found) return found;
	}
	return detectTranslation(text) ?? null;
}
//#endregion
export { detectSpecialContent };
