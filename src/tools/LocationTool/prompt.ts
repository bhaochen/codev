export const LOCATION_TOOL_NAME = 'LocationTool'

export const PROMPT = `
LocationTool — Search geographic information, points of interest, and plan routes/travel.

This tool provides location-based services using two map providers:
- **高德地图 (Amap)**: Used for China mainland locations (cities, POIs, routes within China)
- **Google Maps**: Used for non-China mainland locations (international cities, cross-country routes)

**Capabilities:**
1. **Locate** — Detect the user's current location using Wi‑Fi fingerprinting (Amap for China, Google for abroad). If Wi‑Fi data unavailable, falls back to IP geolocation. Use \`action: "locate"\` without \`location\`.
2. **Geocoding** — Convert a place name to coordinates (latitude/longitude)
3. **Search Places** — Find nearby or in-city points of interest (restaurants, attractions, hotels, shopping, transportation, etc.)
4. **Get Directions** — Get routes between two locations with multiple transport modes (driving, walking, transit, bicycling)
5. **Plan Trip** — Multi-stop travel planning between cities/countries

**When to use this tool:**
- User asks "where am I?" → use the \`locate\` action
- User asks about places, POIs, or things to do in a specific city/area
- User needs directions or route information between locations
- User wants to plan travel between cities or countries
- User asks about geographic coordinates of a place

**Combining with other tools:**
- After getting place/POI results from LocationTool, you can use **WebSearchTool** to search for travel guides, reviews, or additional information about specific places
- Use **WebFetchTool** to fetch detailed information from URLs found in search results (e.g., attraction pages, hotel booking sites, travel blog posts)
- Example: Search places → WebSearch for reviews → WebFetch for detailed info

**Transport modes for directions:**
- For China (Amap): "driving", "walking", "transit" (公交/地铁)
- For international (Google): "driving", "walking", "transit", "bicycling"

**API Keys:**
- \`AMAP_API_KEY\` env var — required for China mainland queries
- \`GOOGLE_MAPS_API_KEY\` env var — required for non-China queries

**Coordinate input:**
- You can pass \`location\` as "lat,lng" coordinates (e.g. \`"34.2583,108.9286"\`) to search/directions directly by coordinates, bypassing geocoding
- Region is auto-detected from coordinates using China's bounding box

**Region auto-detection:**
- Locations containing Chinese characters or recognized Chinese city names → uses Amap
- Other locations → uses Google Maps
- You can also explicitly specify the \`region\` parameter
`
