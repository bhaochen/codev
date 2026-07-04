import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { LOCATION_TOOL_NAME, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { fetchImagesAsInline } from '../../utils/inlineImageUtils.js'

// ── Region detection ────────────────────────────────────────────────────────

/** Chinese cities known to be in mainland China */
const CHINA_CITIES = new Set([
  '北京', '上海', '广州', '深圳', '成都', '杭州', '武汉', '西安', '重庆',
  '南京', '天津', '苏州', '长沙', '郑州', '东莞', '青岛', '沈阳', '宁波',
  '昆明', '大连', '厦门', '合肥', '佛山', '福州', '哈尔滨', '济南', '温州',
  '长春', '石家庄', '常州', '泉州', '南宁', '贵阳', '南昌', '太原', '烟台',
  '嘉兴', '南通', '金华', '珠海', '惠州', '徐州', '海口', '乌鲁木齐', '绍兴',
  '中山', '台州', '兰州', 'beijing', 'shanghai', 'guangzhou', 'shenzhen',
  'chengdu', 'hangzhou', 'wuhan', 'xi\'an', 'chongqing', 'nanjing',
  'tianjin', 'suzhou', 'changsha', 'zhengzhou', 'qingdao', 'shenyang',
  'kunming', 'dalian', 'xiamen', 'hefei', 'foshan', 'fuzhou', 'harbin',
  'jinan', 'changchun', 'shijiazhuang', 'nanning', 'guiyang', 'nanchang',
  'taiyuan', 'haikou', 'urumqi', 'lanzhou', 'macau', 'macao', 'hong kong',
  'xianggang',
])

const NON_CHINA_COUNTRIES = new Set([
  'japan', 'korea', 'south korea', 'usa', 'united states', 'uk', 'united kingdom',
  'france', 'germany', 'italy', 'spain', 'australia', 'canada', 'brazil',
  'india', 'thailand', 'vietnam', 'singapore', 'malaysia', 'indonesia',
  'philippines', 'russia', 'mexico', 'turkey', 'egypt', 'switzerland',
  'sweden', 'norway', 'finland', 'denmark', 'netherlands', 'belgium',
  'portugal', 'greece', 'ireland', 'new zealand', 'argentina', 'chile',
  'peru', 'colombia', 'south africa', 'nigeria', 'kenya', 'morocco',
  '美国', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙',
  '澳大利亚', '加拿大', '巴西', '印度', '泰国', '越南', '新加坡',
  '马来西亚', '俄罗斯', '土耳其', '埃及', '瑞士', '荷兰', '新西兰',
])

function isChinaMainland(location: string): boolean {
  // Normalize curly/smart quotes to straight quotes for matching
  const normalized = location.replace(/[\u2018\u2019]/g, "'")

  // Contains Chinese characters → likely China
  if (/[\u4e00-\u9fff]/.test(normalized)) {
    // Check for non-China country names in Chinese
    const lower = normalized.toLowerCase()
    for (const country of NON_CHINA_COUNTRIES) {
      if (lower.includes(country)) return false
    }
    return true
  }

  const lower = normalized.toLowerCase().trim()

  // Check Chinese city names
  for (const city of CHINA_CITIES) {
    if (lower.startsWith(city) || lower.includes(` ${city}`) || lower.includes(`, ${city}`)) {
      return true
    }
  }

  // If it looks like a country name, check against known non-China list
  if (NON_CHINA_COUNTRIES.has(lower)) return false

  // Default: if location is purely alphabetic/pinyin, assume non-China
  return false
}

/** Parse "lat,lng" coordinate string (e.g. "34.2583,108.9286") */
function parseCoords(input: string): { lat: number; lng: number } | null {
  const trimmed = input.trim()
  const match = trimmed.match(/^(-?\d+\.?\d*)\s*[,，]\s*(-?\d+\.?\d*)$/)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lng = parseFloat(match[2])
  if (isNaN(lat) || isNaN(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

/** Detect China mainland from coordinates (rough bounding box) */
function isChinaCoords(lat: number, lng: number): boolean {
  return lat >= 18 && lat <= 54 && lng >= 73 && lng <= 135
}

/** Build a LocationResult from parsed coordinates */
function coordsToLocation(lat: number, lng: number): LocationResult {
  return {
    lat,
    lng,
    formattedAddress: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    displayName: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
  }
}

/** IP geolocation result for the locate action */
type IpGeoInfo = {
  ip: string
  city: string
  region: string
  country: string
  lat?: number
  lng?: number
}

/** Scan nearby WiFi access points via nmcli */
async function scanWiFi(): Promise<{ macAddress: string; signalStrength: number }[]> {
  try {
    const cmd = new Deno.Command('nmcli', {
      args: ['-t', '-f', 'BSSID,SIGNAL', 'device', 'wifi', 'list'],
      stdout: 'piped',
      stderr: 'null',
    })
    const { stdout } = await cmd.output()
    const text = new TextDecoder().decode(stdout)
    return text.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        // nmcli -t escapes colons inside values as \:, split on unescaped :
        const fields = line.split(/(?<!\\):/)
        if (fields.length < 2) return null
        const bssid = fields[0].replace(/\\([\da-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        const signal = parseInt(fields[1], 10)
        if (isNaN(signal)) return null
        return { macAddress: bssid, signalStrength: signal }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
  } catch {
    return []
  }
}

/** Google Geolocation API — uses WiFi AP data for precise positioning */
// Amap Wi‑Fi 基站定位（国内）— 使用 apilocate.amap.com/position（GET）
async function amapWiFiGeolocateAPI(wifiAPs: { macAddress: string; signalStrength: number }[]): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  const key = process.env.AMAP_API_KEY
  if (!key) return null
  try {
    if (wifiAPs.length < 2) return null // Amap 要求至少 2 个 AP

    // 构造 macs 参数：mac1,signal1,ssid1|mac2,signal2,ssid2|...
    // signal 为负 dBm（nmcli 返回 0‑100，取负作为近似值）
    const macs = wifiAPs.slice(0, 30).map(ap =>
      `${ap.macAddress},${-ap.signalStrength},`
    ).join('|')

    const params = new URLSearchParams({
      key,
      accesstype: '1',
      cdma: '0',
      macs,
      output: 'json',
    })

    const res = await fetch(`https://apilocate.amap.com/position?${params}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    // Amap 返回 { status: "1", info: "OK", result: { location: "lng,lat", radius: number, ... } }
    if (data.status === '1' && data.result?.location) {
      const [lng, lat] = data.result.location.split(',').map(Number)
      if (!isNaN(lat) && !isNaN(lng)) {
        return {
          lat,
          lng,
          accuracy: data.result.radius || 0,
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// Google Geolocation API（海外）
async function googleGeolocateAPI(wifiAPs: { macAddress: string; signalStrength: number }[]): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return null
  try {
    const body: any = {}
    if (wifiAPs.length > 0) {
      body.wifiAccessPoints = wifiAPs.slice(0, 20)
      body.considerIp = false
    } else {
      body.considerIp = true
    }
    const res = await fetch('https://www.googleapis.com/geolocation/v1/geolocate?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    if (data.location?.lat && data.location?.lng) {
      return {
        lat: data.location.lat,
        lng: data.location.lng,
        accuracy: data.accuracy || 0,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Detect user location via IP (3 fallback services).
 * Only used by the explicit `locate` action.
 */
async function ipGeolocate(): Promise<IpGeoInfo> {
  const services = [
    'https://ipinfo.io/json',
    'https://ipapi.co/json/',
    'http://ip-api.com/json/',
  ]
  for (const url of services) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const data = await res.json() as any

      // ipinfo.io
      if (data.city) {
        const loc = data.loc?.split(',').map(Number) as [number, number] | undefined
        return {
          ip: data.ip || 'unknown',
          city: data.city,
          region: data.region || '',
          country: data.country || '',
          lat: loc?.[0],
          lng: loc?.[1],
        }
      }
      // ipapi.co
      if (data.city) {
        return {
          ip: data.ip || 'unknown',
          city: data.city,
          region: data.region || '',
          country: data.country_name || data.country || '',
          lat: data.latitude,
          lng: data.longitude,
        }
      }
      // ip-api.com
      if (data.city) {
        return {
          ip: data.query || 'unknown',
          city: data.city,
          region: data.regionName || data.region || '',
          country: data.country || '',
          lat: data.lat,
          lng: data.lon,
        }
      }
    } catch {
      continue
    }
  }
  throw new Error('Could not determine location via IP (all geolocation services failed)')
}

// ── Input / Output schemas ───────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['geocode', 'search_places', 'get_directions', 'plan_trip', 'locate'])
      .describe('The action to perform'),
    location: z.any().optional().default('').describe('The location name, address, or origin for directions (optional for locate; defaults to empty string)'),
    destination: z.string().optional()
      .describe('Destination location (required for get_directions and plan_trip)'),
    query: z.string().optional()
      .describe('Search query for places (e.g., restaurants, attractions, hotels). Required for search_places'),
    radius: z.number().min(1).max(50000).optional().default(5000)
      .describe('Search radius in meters (default: 5000, max: 50000)'),
    mode: z.enum(['driving', 'walking', 'transit', 'bicycling']).optional().default('driving')
      .describe('Transport mode for directions (default: driving)'),
    waypoints: z.array(z.string()).max(10).optional()
      .describe('Intermediate stops for multi-city trip planning (max 10)'),
    type: z.string().optional()
      .describe('POI type filter for Amap (e.g., 餐饮, 酒店, 景点, 购物). Only applies to China locations'),
    region: z.enum(['china', 'international']).optional()
      .describe('Force region. Auto-detected if not specified'),
    language: z.string().optional().default('zh-CN')
      .describe('Response language (default: zh-CN)'),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>

type LocationResult = {
  lat: number
  lng: number
  formattedAddress: string
  displayName: string
}

type PlaceResult = {
  name: string
  address: string
  lat: number
  lng: number
  rating?: number
  types?: string[]
  phone?: string
  website?: string
  openingHours?: string
  photos?: string[]
  /** Amap-specific fields */
  distance?: string
  businessArea?: string
  cost?: string
  recommendation?: string
  tag?: string
}

type DirectionStep = {
  instruction: string
  distance: string
  duration: string
  mode?: string
  polyline?: string
}

type DirectionLeg = {
  steps: DirectionStep[]
  distance: string
  duration: string
  startAddress: string
  endAddress: string
}

type DirectionsResult = {
  origin: string
  destination: string
  mode: string
  legs: DirectionLeg[]
  totalDistance: string
  totalDuration: string
  polyline?: string
  transitInfo?: string
  tolls?: string
  trafficRestriction?: string
}

type Output = {
  action: string
  region: 'china' | 'international'
  geocoding?: LocationResult
  places?: PlaceResult[]
  directions?: DirectionsResult
  error?: string
  rawData?: unknown
  ipGeo?: IpGeoInfo
  images?: Array<{ url: string; base64: string; mediaType: string }>
}

// ── Amap API helpers ─────────────────────────────────────────────────────────

function getAmapKey(): string {
  const key = process.env.AMAP_API_KEY
  if (!key) throw new Error('AMAP_API_KEY environment variable is not set')
  return key
}

async function amapGeocode(location: string, city?: string): Promise<LocationResult> {
  const key = getAmapKey()
  const params = new URLSearchParams({ key, address: location })
  if (city) params.set('city', city)

  const res = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Amap geocode HTTP ${res.status}`)

  const data = await res.json() as any
  if (data.status !== '1' || !data.geocodes?.length) {
    throw new Error(`Amap geocode failed: ${data.info || 'no results'}`)
  }

  const [lng, lat] = data.geocodes[0].location.split(',').map(Number)
  return {
    lat,
    lng,
    formattedAddress: data.geocodes[0].formatted_address || location,
    displayName: data.geocodes[0].formatted_address || location,
  }
}

async function amapSearchPlaces(
  location: string,
  query?: string,
  type?: string,
  radius?: number,
  /** Pre-resolved coordinates (skip geocoding) */
  geo?: LocationResult,
): Promise<PlaceResult[]> {
  const key = getAmapKey()

  // Use pre-resolved coordinates if available, otherwise geocode
  const resolved = geo ?? await amapGeocode(location)

  const allPois: any[] = []
  const maxPages = 20 // 高德最多返回 10000 条 (offset 10000 × page 1 就夠了，分頁當備用)
  const pageSize = 1000

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      key,
      location: `${resolved.lng},${resolved.lat}`,
      radius: String(radius || 5000),
      offset: String(pageSize),
      page: String(page),
      extensions: 'all',
    })
    if (query) params.set('keywords', query)
    if (type) params.set('types', type)

    const res = await fetch(`https://restapi.amap.com/v3/place/around?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) throw new Error(`Amap around search HTTP ${res.status}`)
    const data = await res.json() as any

    if (data.status !== '1') {
      throw new Error(`Amap search failed: ${data.info}`)
    }

    const pois = data.pois || []
    allPois.push(...pois)

    // 如果這頁沒滿 pageSize，或已達總數，停止翻頁
    if (pois.length < pageSize || allPois.length >= Number(data.count || 0)) break

    // 高德限制每秒 3 次請求，稍微等一下
    await new Promise(r => setTimeout(r, 350))
  }

  return allPois.map((poi: any) => ({
    name: poi.name,
    address: poi.address || '',
    lat: parseFloat(poi.location?.split(',')[1] || '0'),
    lng: parseFloat(poi.location?.split(',')[0] || '0'),
    distance: poi.distance,
    businessArea: poi.business_area,
    cost: poi.cost,
    type: poi.type,
    tag: (poi.type || '').split(';').filter(Boolean).join(', '),
    photos: (poi.photos || []).map((p: any) => p.url).filter(Boolean),
    openingHours: poi.opentime || poi.biz_ext?.opentime,
    recommendation: poi.recommend || poi.biz_ext?.rating,
  }))
}

async function amapDirections(
  origin: string,
  destination: string,
  mode: string,
  /** Pre-resolved origin coordinates (skip geocoding) */
  origGeo?: LocationResult,
  /** Pre-resolved destination coordinates (skip geocoding) */
  destGeo?: LocationResult,
): Promise<DirectionsResult> {
  const key = getAmapKey()
  const originGeo = origGeo ?? await amapGeocode(origin)
  const destinationGeo = destGeo ?? await amapGeocode(destination)

  // Map our mode to Amap mode
  const amapMode = mode === 'transit' ? 'transit' : 'driving'
  const apiUrl = amapMode === 'transit'
    ? 'https://restapi.amap.com/v3/direction/transit/integrated'
    : 'https://restapi.amap.com/v3/direction/driving'

  const params = new URLSearchParams({
    key,
    origin: `${originGeo.lng},${originGeo.lat}`,
    destination: `${destinationGeo.lng},${destinationGeo.lat}`,
    extensions: 'all',
    strategy: '0',
  })

  if (amapMode === 'transit') {
    params.set('city', '')
    params.set('cityd', '')
  }

  const res = await fetch(`${apiUrl}?${params}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) throw new Error(`Amap directions HTTP ${res.status}`)
  const data = await res.json() as any

  if (data.status !== '1' || !data.route) {
    throw new Error(`Amap directions failed: ${data.info || 'no route'}`)
  }

  const route = data.route
  const path = route.paths?.[0] || route.transits?.[0]
  if (!path) throw new Error('No route found')

  const legs: DirectionLeg[] = [{
    steps: (path.steps || []).map((s: any) => ({
      instruction: s.instruction || '',
      distance: `${(parseFloat(s.distance) / 1000).toFixed(1)} km`,
      duration: `${Math.round(parseFloat(s.duration) / 60)} min`,
      polyline: s.polyline,
    })),
    distance: `${(parseFloat(path.distance) / 1000).toFixed(1)} km`,
    duration: `${Math.round(parseFloat(path.duration) / 60)} min`,
    startAddress: origin,
    endAddress: destination,
  }]

  const result: DirectionsResult = {
    origin,
    destination,
    mode,
    legs,
    totalDistance: legs[0].distance,
    totalDuration: legs[0].duration,
  }

  if (amapMode === 'transit') {
    result.transitInfo = `Transit: ${path.transit_mode || 'public transport'}`
    result.tolls = path.tolls ? `¥${path.tolls}` : undefined
  }

  return result
}

// ── Google Maps API helpers ───────────────────────────────────────────────────

function getGoogleKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY environment variable is not set')
  return key
}

async function googleGeocode(location: string, language?: string): Promise<LocationResult> {
  const key = getGoogleKey()
  const params = new URLSearchParams({ address: location, key })
  if (language) params.set('language', language)

  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`Google geocode HTTP ${res.status}`)
  const data = await res.json() as any

  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Google geocode failed: ${data.status} — ${data.error_message || 'no results'}`)
  }

  const result = data.results[0]
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    displayName: result.formatted_address,
  }
}

async function googleSearchPlaces(
  location: string,
  query?: string,
  radius?: number,
  language?: string,
  /** Pre-resolved coordinates (skip geocoding) */
  geo?: LocationResult,
): Promise<PlaceResult[]> {
  const key = getGoogleKey()
  const resolved = geo ?? await googleGeocode(location, language)
  const allPlaces: any[] = []
  const baseUrl = query
    ? 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    : 'https://maps.googleapis.com/maps/api/place/nearbysearch/json'

  let nextPageToken: string | undefined

  for (let page = 0; page < 3; page++) { // Google 最多 60 條（3 頁 × 20）
    const params = new URLSearchParams({ key, language: language || 'zh-CN' })

    if (page === 0) {
      if (query) {
        params.set('query', `${query} in ${location}`)
      } else {
        params.set('location', `${resolved.lat},${resolved.lng}`)
        params.set('radius', String(radius || 5000))
      }
    } else if (nextPageToken) {
      // 翻頁需要等 2 秒讓 token 生效
      await new Promise(r => setTimeout(r, 2000))
      params.set('pagetoken', nextPageToken)
    }

    const res = await fetch(`${baseUrl}?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) throw new Error(`Google places search HTTP ${res.status}`)
    const data = await res.json() as any
    if (data.status !== 'OK') {
      if (allPlaces.length > 0) break // 翻頁失敗但已有結果，繼續
      throw new Error(`Google places search failed: ${data.status} — ${data.error_message || ''}`)
    }

    allPlaces.push(...(data.results || []))
    nextPageToken = data.next_page_token
    if (!nextPageToken) break
  }

  return parseGooglePlacesResults(allPlaces, resolved)
}

function parseGooglePlacesResults(results: any[], geo: LocationResult): PlaceResult[] {
  return (results || []).map((place: any) => ({
    name: place.name,
    address: place.formatted_address || place.vicinity || '',
    lat: place.geometry?.location?.lat || geo.lat,
    lng: place.geometry?.location?.lng || geo.lng,
    rating: place.rating,
    types: place.types,
    phone: place.formatted_phone_number,
    website: place.website,
    openingHours: place.opening_hours?.open_now ? 'Open now' : undefined,
    photos: (place.photos || []).map((p: any) =>
      `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${p.photo_reference}&key=${getGoogleKey()}`
    ),
    cost: place.price_level ? '💰'.repeat(place.price_level) : undefined,
  }))
}

async function googleDirections(
  origin: string,
  destination: string,
  mode: string,
  language?: string,
): Promise<DirectionsResult> {
  const key = getGoogleKey()
  const params = new URLSearchParams({
    origin,
    destination,
    mode,
    key,
    language: language || 'zh-CN',
    alternatives: 'true',
  })

  const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) throw new Error(`Google directions HTTP ${res.status}`)
  const data = await res.json() as any

  if (data.status !== 'OK' || !data.routes?.length) {
    throw new Error(`Google directions failed: ${data.status} — ${data.error_message || 'no route'}`)
  }

  const route = data.routes[0]
  const legs: DirectionLeg[] = (route.legs || []).map((leg: any) => ({
    steps: (leg.steps || []).map((s: any) => ({
      instruction: s.html_instructions?.replace(/<[^>]+>/g, '') || '',
      distance: s.distance?.text || '',
      duration: s.duration?.text || '',
      mode: s.travel_mode,
    })),
    distance: leg.distance?.text || '',
    duration: leg.duration?.text || '',
    startAddress: leg.start_address || origin,
    endAddress: leg.end_address || destination,
  }))

  return {
    origin,
    destination,
    mode,
    legs,
    totalDistance: legs[0]?.distance || '',
    totalDuration: legs[0]?.duration || '',
    polyline: route.overview_polyline?.points,
  }
}

// ── Main call logic ───────────────────────────────────────────────────────────

async function handleGeocode(
  location: string,
  region: 'china' | 'international',
  language?: string,
  /** Pre-resolved coordinates (skip geocoding) */
  coords?: LocationResult,
): Promise<LocationResult> {
  if (coords) return coords
  if (region === 'china') {
    return await amapGeocode(location)
  }
  return await googleGeocode(location, language)
}

async function handleSearchPlaces(
  location: string,
  query: string | undefined,
  type: string | undefined,
  radius: number | undefined,
  region: 'china' | 'international',
  language?: string,
  /** Pre-resolved coordinates (skip geocoding) */
  coords?: LocationResult,
): Promise<PlaceResult[]> {
  if (region === 'china') {
    return await amapSearchPlaces(location, query, type, radius, coords)
  }
  return await googleSearchPlaces(location, query, radius, language, coords)
}

async function handleDirections(
  origin: string,
  destination: string,
  mode: string,
  region: 'china' | 'international',
  language?: string,
  /** Pre-resolved origin coordinates */
  origCoords?: LocationResult,
  /** Pre-resolved destination coordinates */
  destCoords?: LocationResult,
): Promise<DirectionsResult> {
  if (region === 'china') {
    return await amapDirections(origin, destination, mode, origCoords, destCoords)
  }
  return await googleDirections(origin, destination, mode, language)
}

async function handlePlanTrip(
  origin: string,
  destination: string,
  waypoints: string[] | undefined,
  mode: string,
  region: 'china' | 'international',
  language?: string,
  /** Pre-resolved origin coordinates */
  origCoords?: LocationResult,
  /** Pre-resolved destination coordinates */
  destCoords?: LocationResult,
) {
  // Multi-stop: combine waypoints into a single route
  if (waypoints && waypoints.length > 0) {
    // We run directions sequentially for each leg to get complete info
    const legs: DirectionLeg[] = []
    let currentOrigin = origin
    let currentCoords = origCoords

    for (const wp of waypoints) {
      const leg = await handleDirections(currentOrigin, wp, mode, region, language, currentCoords)
      legs.push(...leg.legs)
      currentOrigin = wp
      currentCoords = undefined // waypoints are strings, not coordinates
    }
    // Final leg
    const finalLeg = await handleDirections(currentOrigin, destination, mode, region, language, undefined, destCoords)
    legs.push(...finalLeg.legs)

    const totalDist = legs.reduce((sum, l) => sum + parseFloat(l.distance) || 0, 0)
    const totalDur = legs.reduce((sum, l) => sum + parseFloat(l.duration) || 0, 0)

    return {
      origin,
      destination,
      mode,
      legs,
      totalDistance: `${totalDist.toFixed(1)} km`,
      totalDuration: `${Math.round(totalDur)} min`,
      waypoints: [origin, ...waypoints, destination],
    }
  }

  // Simple point-to-point
  return await handleDirections(origin, destination, mode, region, language)
}

// ── Tool export ───────────────────────────────────────────────────────────────

type LocationToolProgress = {
  type: 'query_update' | 'results_received'
  action?: string
  location?: string
}

export const LocationTool = buildTool({
  name: LOCATION_TOOL_NAME,
  searchHint: 'geographic search, POI, maps, directions, travel planning',
  shouldDefer: true,

  getToolUseSummary,
  getActivityDescription(input) {
    const loc = input?.location || ''
    const action = input?.action || 'query'
    return `${action} for "${loc}"`
  },

  isEnabled() {
    return true
  },

  get inputSchema() {
    return inputSchema()
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return input?.action
      ? `${input.action}: ${input?.location || '(IP auto-detect)'}`
      : ''
  },

  async checkPermissions() {
    return { behavior: 'allow' }
  },

  async prompt() {
    return PROMPT
  },

  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,

  extractSearchText(output) {
    if (!output) return ''
    const parts: string[] = []
    if (output.geocoding) parts.push(`geocode: ${output.geocoding.formattedAddress}`)
    if (output.places?.length) parts.push(`places: ${output.places.length} results`)
    if (output.directions) parts.push(`route: ${output.directions.origin} → ${output.directions.destination}`)
    return parts.join('; ')
  },

  async validateInput(input) {
    if (input?.action !== 'locate' && (!input?.location || input?.location.length === 0)) {
      return { result: false, message: 'Missing location parameter', errorCode: 1 }
    }
    if (input.action === 'get_directions' || input.action === 'plan_trip') {
      if (!input.destination) {
        return { result: false, message: 'Missing destination parameter for directions/trip', errorCode: 1 }
      }
    }
    if (input.action === 'search_places' && !input.query && !input.type) {
      return { result: false, message: 'Missing query or type parameter for place search', errorCode: 1 }
    }
    return { result: true }
  },

  async call(input, _context, _canUseTool, _parentMessage, onProgress) {
    const { action, location, destination, query, radius, mode, waypoints, type, region: forcedRegion, language } = input

    // Detect coordinate input (e.g. "34.2583,108.9286")
    const originCoords = typeof location === 'string' ? parseCoords(location) : undefined
    const destCoords = destination ? parseCoords(destination) : undefined

    // Region: coordinates override text-based detection
    let region = forcedRegion
    if (!region && originCoords) {
      region = isChinaCoords(originCoords.lat, originCoords.lng) ? 'china' : 'international'
    }
    if (!region && location) {
      region = isChinaMainland(location) ? 'china' : 'international'
    }
    if (!region) {
      region = 'international'
    }

    // Build pre-resolved origin LocationResult from coordinates
    const originLocationResult = originCoords ? coordsToLocation(originCoords.lat, originCoords.lng) : undefined
    const destLocationResult = destCoords ? coordsToLocation(destCoords.lat, destCoords.lng) : undefined

    if (onProgress) {
      onProgress({
        toolUseID: 'location-start',
        data: { type: 'query_update', action, location: location || '(locate)' },
      })
    }

    try {
      let ipGeo: IpGeoInfo | undefined
      let geocoding: LocationResult | undefined
      let places: PlaceResult[] | undefined
      let directions: DirectionsResult | undefined
      let images: Output['images']

      switch (action) {
        case 'geocode':
          geocoding = await handleGeocode(location, region, language, originLocationResult)
          break

        case 'search_places':
          places = await handleSearchPlaces(location, query, type, radius ?? 5000, region, language, originLocationResult)
          break

        case 'get_directions':
          if (!destination) throw new Error('Destination is required for directions')
          directions = await handleDirections(location, destination, mode ?? 'driving', region, language, originLocationResult, destLocationResult)
          break

        case 'plan_trip':
          if (!destination) throw new Error('Destination is required for trip planning')
          const planResult = await handlePlanTrip(location, destination, waypoints, mode ?? 'driving', region, language, originLocationResult, destLocationResult)
          directions = planResult as DirectionsResult
          break

        case 'locate': {
          // 1. 首先尝试国内 Amap Wi‑Fi 定位（若在中国大陆）
          const wifiAPs = await scanWiFi()
          const amapLoc = await amapWiFiGeolocateAPI(wifiAPs)
          if (amapLoc) {
            region = isChinaCoords(amapLoc.lat, amapLoc.lng) ? 'china' : 'international'
            geocoding = coordsToLocation(amapLoc.lat, amapLoc.lng)
            ipGeo = {
              ip: 'amap-wifi',
              city: `${amapLoc.lat.toFixed(4)},${amapLoc.lng.toFixed(4)}`,
              region: `accuracy: ${amapLoc.accuracy}m`,
              country: region === 'china' ? 'CN' : 'unknown',
              lat: amapLoc.lat,
              lng: amapLoc.lng,
            }
            break
          }

          // 2. 若 Amap 未返回或不在中国大陆，尝试国外 Google Geolocation API
          const googleLoc = await googleGeolocateAPI(wifiAPs)
          if (googleLoc) {
            region = 'international'
            geocoding = coordsToLocation(googleLoc.lat, googleLoc.lng)
            ipGeo = {
              ip: 'google-geolocation',
              city: `${googleLoc.lat.toFixed(4)},${googleLoc.lng.toFixed(4)}`,
              region: `accuracy: ${googleLoc.accuracy}m`,
              country: 'unknown',
              lat: googleLoc.lat,
              lng: googleLoc.lng,
            }
            break
          }

          // 3. 最后回退到 IP 定位（城市级）
          ipGeo = await ipGeolocate()
          const detectRegion = ipGeo.country === 'CN' ? 'china' : 'international'
          const detectCoords = ipGeo.lat && ipGeo.lng
            ? coordsToLocation(ipGeo.lat, ipGeo.lng)
            : undefined
          if (detectCoords) {
            geocoding = detectCoords
          } else {
            geocoding = await handleGeocode(ipGeo.city, detectRegion, language)
          }
          region = detectRegion
          break
        }
      }

      if (onProgress) {
        onProgress({
          toolUseID: 'location-results',
          data: {
            type: 'results_received',
            action,
            location: action === 'locate' ? ipGeo?.city : location,
            ...(places && { count: places.length }),
          } as any,
        })
      }

      if (places && places.length > 0) {
        const photoUrls = places
          .flatMap((p) => p.photos ?? [])
          .slice(0, 6)
        if (photoUrls.length > 0) {
          images = await fetchImagesAsInline(photoUrls, 6)
        }
      }

      return {
        data: {
          action,
          region,
          geocoding,
          places,
          directions,
          ipGeo,
          images,
        } satisfies Output,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logError('LocationTool error', error)

      return {
        data: {
          action,
          region,
          error: errorMessage,
          ipGeo,
        } satisfies Output,
      }
    }
  },

  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const lines: string[] = []
    lines.push(`📍 Location Result [${output.action}]`)
    lines.push(`Region: ${output.region === 'china' ? '中国大陆' : '海外'}`)
    if (output.ipGeo) {
      const g = output.ipGeo
      lines.push(`IP: ${g.ip} — ${g.city}, ${g.region} (${g.country})`)
      if (g.lat && g.lng) lines.push(`Coords: ${g.lat}, ${g.lng}`)
    }
    lines.push('')

    if (output.error) {
      lines.push(`Error: ${output.error}`)
    }

    if (output.geocoding) {
      const g = output.geocoding
      lines.push(`┌─ 地理编码结果`)
      lines.push(`│ 地址: ${g.formattedAddress}`)
      lines.push(`│ 坐标: ${g.lat}, ${g.lng}`)
      lines.push(`│ 地图: https://${output.region === 'china' ? 'uri.amap.com/marker?position=' : 'www.google.com/maps?q='}${g.lat},${g.lng}`)
      lines.push(`└────\n`)
    }

    if (output.places && output.places.length > 0) {
      lines.push(`┌─ 搜索结果 (${output.places.length} 条)`)
      output.places.forEach((p, i) => {
        lines.push(`│`)
        lines.push(`│ [${i + 1}] ${p.name}`)
        if (p.address) lines.push(`│     地址: ${p.address}`)
        if (p.distance) lines.push(`│     距离: ${p.distance}米`)
        if (p.tag) lines.push(`│     类别: ${p.tag}`)
        if (p.rating) lines.push(`│     评分: ${'⭐'.repeat(Math.round(p.rating))} (${p.rating})`)
        if (p.cost) lines.push(`│     消费: ${p.cost}`)
        if (p.openingHours) lines.push(`│     营业: ${p.openingHours}`)
        if (p.phone) lines.push(`│     电话: ${p.phone}`)
        if (p.photos?.length) {
          lines.push(`│     照片: ${p.photos.map((ph, idx) => `[图${idx + 1}](${ph})`).join(' ')}`)
        }
      })
      lines.push(`└────\n`)
    }

    if (output.directions) {
      const d = output.directions
      lines.push(`┌─ 路线规划`)
      lines.push(`│ 起点: ${d.origin}`)
      lines.push(`│ 终点: ${d.destination}`)
      lines.push(`│ 交通方式: ${d.mode}`)
      lines.push(`│ 总距离: ${d.totalDistance}`)
      lines.push(`│ 预计耗时: ${d.totalDuration}`)
      if (d.transitInfo) lines.push(`│ 公共交通: ${d.transitInfo}`)
      if (d.tolls) lines.push(`│ 通行费: ${d.tolls}`)

      if (d.legs.length > 0) {
        lines.push(`│`)
        d.legs.forEach((leg, li) => {
          if (d.legs.length > 1) lines.push(`│ 路段 ${li + 1}: ${leg.startAddress} → ${leg.endAddress}`)
          lines.push(`│   距离: ${leg.distance} | 时间: ${leg.duration}`)
          leg.steps.slice(0, 10).forEach(s => {
            const instr = s.instruction.length > 80 ? s.instruction.slice(0, 80) + '…' : s.instruction
            lines.push(`│   → ${instr} (${s.distance}, ${s.duration})`)
          })
          if (leg.steps.length > 10) {
            lines.push(`│   … 还有 ${leg.steps.length - 10} 个步骤`)
          }
        })
      }
      lines.push(`└────`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        { type: 'text', text: lines.join('\n') },
        ...(output.images?.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: img.base64,
            media_type: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          },
        })) ?? []),
      ],
    }
  },
}) satisfies ToolDef<ReturnType<typeof inputSchema>, Output, LocationToolProgress>
