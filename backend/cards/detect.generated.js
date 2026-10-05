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
	"wallet"
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
function detectSystem(text) {
	if (!/\b(system diagnostics|system status|hardware|telemetry|diagnostics|cpu|gpu|ram|memory)\b/i.test(text)) return void 0;
	const cpu = text.match(/\bcpu(?:\s*(?:usage|load|utili[sz]ation))?[^.%\d]{0,15}?(\d+(?:\.\d+)?)\s*%/i);
	const cpuTemp = text.match(/\b(?:cpu\s*)?temp(?:erature)?[^.\d]{0,12}?(\d+(?:\.\d+)?)\s*°\s*C\b/i);
	const ram = text.match(/\b(?:ram|memory)[^.\d]{0,12}?(\d+(?:\.\d+)?)\s*GB\s*(?:\/|of)\s*(\d+(?:\.\d+)?)\s*GB/i);
	const disk = text.match(/\b(?:disk|storage|ssd|nvme)(?:\s*usage)?[^.\d]{0,12}?(\d+(?:\.\d+)?)\s*(GB|TB)\s*(?:\/|of)\s*(\d+(?:\.\d+)?)\s*(GB|TB)/i);
	const gpu = text.match(/\bgpu(?:\s*(?:usage|load|utili[sz]ation))?[^.%\d]{0,12}?(\d+(?:\.\d+)?)\s*%/i);
	const gpuTemp = text.match(/\bgpu\s*temp(?:erature)?[^.\d]{0,8}?(\d+(?:\.\d+)?)\s*°\s*C\b/i);
	const cores = text.match(/(\d+)[- ]core\b/i);
	const toGB = (v, unit) => unit.toUpperCase() === "TB" ? num(v) * 1e3 : num(v);
	const data = compact({
		cpuUsage: cpu ? num(cpu[1]) : void 0,
		cpuTemp: cpuTemp ? num(cpuTemp[1]) : void 0,
		cpuCores: cores ? parseInt(cores[1], 10) : void 0,
		ramUsedGB: ram ? num(ram[1]) : void 0,
		ramTotalGB: ram ? num(ram[2]) : void 0,
		diskUsedGB: disk ? toGB(disk[1], disk[2]) : void 0,
		diskTotalGB: disk ? toGB(disk[3], disk[4]) : void 0,
		gpuUsage: gpu ? num(gpu[1]) : void 0,
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
var TOMORROW = words("tomorrow|demain|amanhã|mañana");
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
			}] : void 0
		})
	};
}
var KNOWN_TICKERS = /\b(BTC|ETH|SOL|AAPL|NVDA|TSLA|AMZN|MSFT|GOOGL|META|SPY|QQQ)\b/;
function detectFinance(text) {
	const tickerM = firstMatch(text, /\(\s*\$?([A-Z]{2,6})\s*\)/, /\$([A-Z]{2,6})\b/, KNOWN_TICKERS);
	if (!tickerM) return void 0;
	const symbol = tickerM[1];
	const priceM = firstMatch(text, /\b(?:trading at|trades at|priced at|price(?: is| of)?|is at|worth)\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)(?!\s*[TBMK]\b)/i, /\$\s*([\d,]+(?:\.\d+)?)(?!\s*[TBMK]\b|[\d,.])/);
	if (!priceM) return void 0;
	if (!/\b(stock|shares?|crypto|market|trading|trades|price|volume|24h|bullish|bearish|up|down)\b/i.test(text) && !text.includes("%")) return void 0;
	const nameM = text.match(new RegExp(`((?:[A-Z][\\w&.\\-]*\\s?){1,4})\\(\\s*\\$?${symbol}\\s*\\)`));
	const signed = text.match(/([+\-−])\s?(\d+(?:\.\d+)?)\s*%/);
	const worded = text.match(/\b(up|rose|gained|climbed|jumped|higher|down|fell|dropped|lost|slid|lower)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i);
	let changePercent;
	if (signed) changePercent = (signed[1] === "+" ? 1 : -1) * num(signed[2]);
	else if (worded) changePercent = (/^(down|fell|dropped|lost|slid|lower)$/i.test(worded[1]) ? -1 : 1) * num(worded[2]);
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
			name: nameM ? nameM[1].trim() : void 0,
			price: num(priceM[1]),
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
	if (!/\b(flight|airline|departure|arrival|gate|terminal|airport|boarding|landed|departed)\b/i.test(text)) return void 0;
	const fn = text.match(/\b((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4})\b/);
	const route = firstMatch(text, /\bfrom\s+([A-Z]{3})\s+to\s+([A-Z]{3})\b/, /\b([A-Z]{3})\s*(?:→|->|–|—)\s*([A-Z]{3})\b/);
	if (!fn || !route) return void 0;
	const [originCode, destCode] = [route[1], route[2]];
	const airline = AIRLINES.find((a) => new RegExp(`\\b${a.replace(/ /g, "\\s+")}\\b`, "i").test(text));
	const status = /\bcancell?ed\b/i.test(text) ? "CANCELLED" : /\bdelayed\b/i.test(text) ? "DELAYED" : /\blanded\b/i.test(text) ? "LANDED" : /\bboarding\b/i.test(text) ? "BOARDING" : /\b(cruising|in flight|en route|airborne|in the air)\b/i.test(text) ? "IN FLIGHT" : /\bon time\b/i.test(text) ? "ON TIME" : /\bscheduled\b/i.test(text) ? "SCHEDULED" : void 0;
	const anchors = [];
	const addAnchors = (re, side) => {
		for (const m of text.matchAll(re)) anchors.push({
			index: m.index ?? 0,
			side
		});
	};
	addAnchors(new RegExp(`\\b${originCode}\\b`, "g"), "origin");
	addAnchors(new RegExp(`\\b${destCode}\\b`, "g"), "destination");
	addAnchors(/\b(?:depart\w*|take[- ]?off|boarding)\b/gi, "origin");
	addAnchors(/\b(?:land\w*|arriv\w*)\b/gi, "destination");
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
	const arrival = text.match(/\b(?:land\w*|arriv\w*)\b[^.]*?\b(\d{1,2}:\d{2})\b/i);
	const departure = text.match(/\b(?:depart\w*|take[- ]?off)\b[^.]*?\b(\d{1,2}:\d{2})\b/i);
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
				scheduledTime: departure?.[1]
			},
			destination: {
				code: destCode,
				...place.destination,
				estimatedTime: arrival?.[1]
			},
			altitude: altitude ? `${altitude[1].replace(/,/g, "")} ${altitude[2] === "feet" ? "ft" : altitude[2]}` : void 0,
			speed: speed?.[1],
			progressPercent: progress ? Math.min(100, parseInt(progress[1], 10)) : void 0,
			duration: duration?.[1]
		})
	};
}
function detectTasks(text) {
	const lines = text.split("\n").filter((l) => /^\s*[-*]\s*\[([ xX])\]\s+(.*)/.test(l));
	if (lines.length < 2) return void 0;
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
function detectRecipe(text) {
	if (!/\b(ingredients?|recipe)\b/i.test(text)) return void 0;
	const ingredients = [];
	const steps = [];
	let section = "none";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (/^#*\s*ingredients\b/i.test(line)) {
			section = "ingredients";
			continue;
		}
		if (/^#*\s*(instructions|steps|directions|method|preparation)\b/i.test(line)) {
			section = "steps";
			continue;
		}
		if (section === "ingredients" && /^[-*•]\s+/.test(line)) ingredients.push({ item: line.replace(/^[-*•]\s+/, "") });
		else if (section === "steps" && /^(?:\d+[.)]|[-*•])\s+/.test(line)) steps.push(line.replace(/^(?:\d+[.)]|[-*•])\s+/, ""));
	}
	if (ingredients.length < 2) return void 0;
	const titleM = firstMatch(text, /\brecipe[:\s]+([^.\n]+)/i, /^#+\s*(?!ingredients|instructions|steps|directions|method|preparation)(.+)$/im);
	const time = (label) => text.match(new RegExp(`${label.source}[:\\s]*(\\d+\\s*(?:min(?:ute)?s?|h(?:ours?|rs?)?)\\b)`, "i"))?.[1];
	const difficulty = text.match(/\b(easy|medium|hard)\b/i)?.[1];
	const servings = firstMatch(text, /\bserves\s*(\d+)/i, /\b(\d+)\s*servings?\b/i);
	return {
		type: "recipe",
		data: compact({
			title: titleM ? titleM[1].replace(/[:#*]/g, "").trim() : "Recipe",
			prepTime: time(/\bprep(?:aration)?\s*time/),
			cookTime: time(/\bcook(?:ing)?\s*time/),
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
function detectSports(text) {
	const m = text.match(/(\p{Lu}[\p{L}.'’ ]*?)\s+(\d{1,3})\s*[-–:]\s*(\d{1,3})\s+(\p{Lu}[\p{L}.'’ ]*?)(?=\s*[.,;!\n]|\s+(?:at|in|on|after|with|to)\b|$)/u);
	if (!m) return void 0;
	if (!/\b(vs|versus|match|game|score|goals?|ft|ht|full[- ]time|half[- ]time|final|league|cup|won|beat|points)\b/i.test(text)) return void 0;
	const status = /\bfull[- ]time\b|\bFT\b/i.test(text) ? "Full time" : /\bhalf[- ]time\b|\bHT\b/i.test(text) ? "Half time" : text.match(/\b(\d{1,3})['’]/)?.[0] ?? (/\bfinal score\b|\bfinal\b/i.test(text) ? "Final" : /\blive\b/i.test(text) ? "Live" : void 0);
	return {
		type: "sports",
		data: compact({
			league: LEAGUES.find((l) => new RegExp(`\\b${l}\\b`, "i").test(text)),
			status,
			teamA: {
				name: m[1].trim(),
				score: parseInt(m[2], 10)
			},
			teamB: {
				name: m[4].trim(),
				score: parseInt(m[3], 10)
			}
		})
	};
}
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
}
function detectChart(text) {
	const rows = text.split("\n").filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"));
	if (rows.length < 4) return void 0;
	const cells = (row) => row.trim().slice(1, -1).split("|").map((c) => c.trim());
	const headers = cells(rows[0]);
	if (headers.length < 2) return void 0;
	const labels = [];
	const values = [];
	for (const row of rows.slice(2)) {
		const [label, value] = cells(row);
		if (!label || value === void 0) continue;
		if (!/^[-+]?\$?[\d,]+(?:\.\d+)?%?$/.test(value)) continue;
		labels.push(label);
		values.push(num(value.replace(/[$%]/g, "")));
	}
	if (values.length < 2) return void 0;
	return {
		type: "chart",
		data: {
			title: headers[1],
			chartType: values.length <= 6 ? "bar" : "line",
			labels,
			datasets: [{
				label: headers[1],
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
		detectTranslation,
		detectChart
	]) {
		const found = detector(text);
		if (found) return found;
	}
	return null;
}
//#endregion
export { detectSpecialContent };
