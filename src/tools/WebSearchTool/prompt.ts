import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()

  return `
- Allows Codev to search the web using a local SearXNG search engine or Tavily cloud search (when TAVILY_API_KEY is configured) and use the results to inform responses
- Provides up-to-date information for current events, technical documentation, and recent data
- Returns structured search results including titles, URLs, and snippets
- Works with all AI providers including local models
- Designed for high-recall search to support reasoning and retrieval-augmented generation (RAG)

Search Strategy:
  - Default: Uses SearXNG metasearch engine (aggregates multiple sources)
  - When TAVILY_API_KEY is set: Uses Tavily cloud search API for high-quality, LLM-optimized results
  - Results may vary in quality; prioritize relevance and credibility
  - If results are weak or empty, try rephrasing the query
  - Prefer more specific queries when possible (add keywords, version numbers, or context)

Image Search (search_images parameter):
  - Set **search_images: true** to search specifically for images (photos, artworks, screenshots).
    Example: WebSearch(query: "milet 写真", search_images: true)
  - When search_images is true, results include direct image URLs (img_src) that you can display
    with ImageShowTool(src: img_src).
  - Example workflow: WebSearch(query: "...", search_images: true) → pick a result → ImageShowTool(src: img_src)
  - Without search_images: true, this is a general web search and image URLs are NOT available.
  - DO NOT pass article/page URLs to ImageShowTool — it only accepts direct image URLs (.jpg/.png/.gif/.webp).

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Only include sources that are actually useful and referenced in your answer

Search Best Practices:
  - Use multiple searches if needed (broad → narrow)
  - Use precise technical terms for programming-related queries
  - For news or recent events, include time context (e.g., year, month)
  - Do NOT assume the first result is correct — synthesize across multiple sources

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}
  - You MUST use this year when searching for recent information, documentation, or current events
  - Example: If the user asks for "latest React docs", search with the current year, NOT outdated versions

Behavior Guidelines:
  - Focus on gathering information, not filtering it prematurely
  - Prioritize recall first, then rely on reasoning to refine
  - Avoid hallucinating information when search results are insufficient — instead, search again
`
}
