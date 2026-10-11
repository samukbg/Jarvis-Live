export const SPECIAL_CONTENT_TYPES = [
  'weather',
  'finance',
  'flight',
  'system',
  'task_roadmap',
  'media_audio',
  'translation',
  'chart',
  'sports',
  'recipe',
  'wallet',
  'business_dashboard'
] as const;

export type SpecialContentType = typeof SPECIAL_CONTENT_TYPES[number];

// Contract: every field is either stated by the agent (JSON or text) or absent.
// Cards render only what exists — nothing is estimated or filled with samples.

export interface WeatherData {
  city?: string;
  region?: string;
  country?: string;
  temp: number;
  tempUnit?: 'C' | 'F';
  condition?: string;
  conditionCode?: 'sunny' | 'cloudy' | 'rain' | 'thunderstorm' | 'snow' | 'fog' | 'night_clear' | 'night_cloudy';
  high?: number;
  low?: number;
  feelsLike?: number;
  humidity?: number;
  windSpeed?: number;
  windDirection?: string;
  windUnit?: string;
  uvIndex?: number;
  uvDescription?: string;
  airQuality?: number;
  airQualityStatus?: string;
  visibility?: number;
  pressure?: number;
  sunrise?: string;
  sunset?: string;
  precipitationChance?: number;
  /** The day the agent's answer is about: 1 = tomorrow, 2 = the day after (else today). */
  forecastDay?: number;
  /** 48 hours ahead, dated (live data): the hours of the day the answer is about. */
  hourlyAhead?: Array<{ date: string; time: string; temp: number; condition?: string; conditionCode?: WeatherData['conditionCode']; pop?: number }>;
  hourlyForecast?: Array<{
    time: string;
    temp: number;
    condition: string;
    conditionCode?: WeatherData['conditionCode'];
    pop?: number; // probability of precipitation
  }>;
  dailyForecast?: Array<{
    date?: string; // YYYY-MM-DD (live data)
    day: string;
    sunrise?: string;
    sunset?: string;
    uvIndex?: number;
    condition?: string;
    conditionCode?: WeatherData['conditionCode'];
    low?: number;
    high?: number;
    pop?: number;
  }>;
  // From live enrichment (Open-Meteo)
  isDay?: boolean;
  windDegrees?: number;
  dewPoint?: number;
  /** Local time at the place ("21:40"), for the sun-cycle arc. */
  localTime?: string;
  liveTemp?: number;
  latitude?: number;
  longitude?: number;
}

export interface FinanceData {
  symbol: string;
  name?: string;
  price: number;
  currency?: string;
  change?: number;
  changePercent?: number;
  marketCap?: string;
  volume24h?: string;
  high24h?: number;
  low24h?: number;
  peRatio?: number;
  week52High?: number;
  week52Low?: number;
  history?: Array<{ time: string; value: number }>;
  // From live enrichment (Yahoo Finance): epoch-ms series per range
  histories?: Partial<Record<FinanceRange, Array<{ t: number; value: number }>>>;
  previousClose?: number;
  exchange?: string;
  instrumentType?: string;
  sector?: string;
  industry?: string;
  dividendYield?: string;
  targetPrice?: number;
  marketCapRank?: number;
  logoUrl?: string;
}

export type FinanceRange = '1D' | '1W' | '1M' | '1Y' | 'ALL';

export interface FlightData {
  flightNumber: string;
  airline?: string;
  status?: 'ON TIME' | 'DELAYED' | 'IN FLIGHT' | 'LANDED' | 'SCHEDULED' | 'CANCELLED' | 'BOARDING';
  origin: {
    code: string;
    city?: string;
    airport?: string;
    terminal?: string;
    gate?: string;
    scheduledTime?: string;
    actualTime?: string;
    latitude?: number;
    longitude?: number;
  };
  destination: {
    code: string;
    city?: string;
    airport?: string;
    terminal?: string;
    gate?: string;
    baggage?: string;
    scheduledTime?: string;
    estimatedTime?: string;
    latitude?: number;
    longitude?: number;
  };
  progressPercent?: number; // 0-100
  duration?: string;
  aircraft?: string;
  altitude?: string;
  speed?: string;
  // From live enrichment (adsbdb / ADSB.lol)
  live?: {
    latitude: number;
    longitude: number;
    altitudeFt?: number;
    speedKts?: number;
    heading?: number;
    verticalRateFpm?: number;
    onGround?: boolean;
  };
  registration?: string;
  aircraftPhotoUrl?: string;
}

export interface SystemDiagnosticsData {
  cpuUsage?: number; // 0-100
  cpuTemp?: number;
  cpuCores?: number;
  gpuUsage?: number;
  gpuTemp?: number;
  ramUsedGB?: number;
  ramTotalGB?: number;
  diskUsedGB?: number;
  diskTotalGB?: number;
  networkUpKBps?: number;
  networkDownKBps?: number;
  batteryPercent?: number;
  isCharging?: boolean;
  topProcesses?: Array<{ name: string; cpu: number; memory: string }>;
  // From live enrichment (the backend host)
  hostname?: string;
  os?: string;
  uptimeHours?: number;
  cpuModel?: string;
  coreLoads?: number[];
  gpuModel?: string;
  vramUsedGB?: number;
  vramTotalGB?: number;
  swapUsedGB?: number;
  disks?: Array<{ mount: string; usedGB: number; totalGB: number }>;
}

export interface TaskRoadmapData {
  projectTitle?: string;
  description?: string;
  progressPercent: number;
  milestones?: Array<{
    title: string;
    status: 'COMPLETED' | 'IN PROGRESS' | 'PENDING';
    date?: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    completed: boolean;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    assignee?: string;
  }>;
}

export interface MediaAudioData {
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: string;
  audioQuality?: string;
  lyrics?: Array<{ time?: string; t?: number; text: string; active?: boolean }>;
  genre?: string;
  releaseYear?: string;
  // From live enrichment (Spotify / Apple Music catalogue / LRCLIB)
  lyricsSynced?: boolean;
  source?: 'spotify';
  isPlaying?: boolean;
  positionSec?: number;
  durationSec?: number;
}

export interface TranslationData {
  sourceLang?: string;
  targetLang?: string;
  sourceText?: string;
  translatedText: string;
  phonetic?: string;
  grammarNotes?: string[];
  alternatives?: string[];
}

export interface ChartData {
  title: string;
  chartType: 'bar' | 'line' | 'area' | 'pie' | 'donut';
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
  }>;
}

export interface SportsScoreData {
  league?: string;
  status?: string; // e.g. "72'", "Full time", "1st Qtr"
  teamA: {
    name: string;
    score: number;
    logo?: string;
    scorers?: string[];
  };
  teamB: {
    name: string;
    score: number;
    logo?: string;
    scorers?: string[];
  };
  stats?: Array<{
    label: string;
    valueA: string | number;
    valueB: string | number;
  }>;
  // From live enrichment (ESPN)
  live?: boolean;
  venue?: string;
  startTime?: string;
}

export interface RecipeData {
  title: string;
  prepTime?: string;
  cookTime?: string;
  servings?: string | number;
  difficulty?: 'Easy' | 'Medium' | 'Hard' | 'Chef Level';
  calories?: number;
  macros?: {
    protein?: string;
    carbs?: string;
    fat?: string;
  };
  ingredients: Array<{ item: string; amount?: string; checked?: boolean }>;
  steps: string[];
  // From enrichment (TheMealDB)
  imageUrl?: string;
  cuisine?: string;
  category?: string;
  videoUrl?: string;
  sourceUrl?: string;
}

export interface WalletToken {
  symbol: string;
  name?: string;
  balance?: number;
  priceUSD?: number;
  valueUSD?: number;
  change24h?: number;
  allocationPercent?: number;
  icon?: string;
  color?: string;
}

export interface WalletNetwork {
  id: string;
  name: string;
  totalUSD: number;
  nativeToken: string;
  tokens: WalletToken[];
}

export interface WalletTransaction {
  hash: string;
  type: 'IN' | 'OUT' | 'SWAP';
  asset: string;
  amount: number;
  valueUSD?: number;
  fromTo: string;
  timestamp: string;
  status: 'CONFIRMED' | 'PENDING';
  network?: string;
  /** Block explorer link. */
  url?: string;
}

export interface WalletData {
  address: string;
  label?: string;
  totalValueUSD?: number;
  change24hUSD?: number;
  change24hPercent?: number;
  defaultNetwork?: string;
  networks: WalletNetwork[];
  /** Holdings stated without a network breakdown. */
  tokens?: WalletToken[];
  recentTransactions?: WalletTransaction[];
}

/** One of the user's projects or businesses, read from a folder on their computer or a website
 * (Settings → Businesses). Every field comes from that source or the analysis of it. */
export interface BusinessKpi {
  label: string;
  value: string;
  /** Short context under the value ("last 30 days"). */
  hint?: string;
  trend?: 'up' | 'down' | 'flat';
}

export interface BusinessOverview {
  id: string;
  name: string;
  kind: 'project' | 'business';
  source: 'folder' | 'website';
  /** The folder path or the website's address. */
  location: string;
  tagline?: string;
  /** Two or three sentences: what it is and where it stands. */
  summary?: string;
  /** 0-100: momentum and condition as the analysis sees them. */
  health?: number;
  status?: 'thriving' | 'steady' | 'needs attention';
  stage?: string;
  /** Its own icon: an absolute URL, or a path on the Jarvis Server ("/api/business/logo/<host>"). */
  logoUrl?: string;
  /** Its public website ("spreadout.ai"). */
  website?: string;
  /** Its main recurring revenue, as numbers (MRR or monthly revenue) — only when the source states it. */
  revenue?: { amount: number; previous?: number; currency?: string; period?: string };
  kpis?: BusinessKpi[];
  /** Activity over time (commits per week for a folder with git history). */
  activity?: { label: string; points: Array<{ t: number; value: number }> };
  highlights?: string[];
  risks?: string[];
  nextSteps?: string[];
  /** ISO time of the analysis. */
  updatedAt?: string;
}

/** The whole portfolio's revenue and its gain / loss (businesses that state a revenue, one currency). */
export interface BusinessTotals {
  revenue: number;
  previous?: number;
  /** revenue − previous over the businesses that state both (negative: a loss). */
  change?: number;
  changePercent?: number;
  currency?: string;
  period?: string;
  /** How many businesses the total covers. */
  businesses: number;
}

export interface BusinessDashboardData {
  businesses: BusinessOverview[];
  totals?: BusinessTotals;
  /** The one to open on (else the first). */
  focusId?: string;
  /** No sources yet: the card invites the user to add one in Settings. */
  empty?: boolean;
}

export interface DetectedSpecialContent {
  type: SpecialContentType;
  data: 
    | WeatherData 
    | FinanceData 
    | FlightData 
    | SystemDiagnosticsData 
    | TaskRoadmapData 
    | MediaAudioData 
    | TranslationData 
    | ChartData 
    | SportsScoreData 
    | RecipeData
    | WalletData
    | BusinessDashboardData;
  summaryText?: string;
}
