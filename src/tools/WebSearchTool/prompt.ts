import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Allows Claude to search the web using DuckDuckGo and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Works with all AI providers including local models

CRITICAL - DOMAIN FILTERING RULES:
  - NEVER use allowed_domains or blocked_domains parameters unless the user EXPLICITLY requests it
  - ALWAYS search ALL domains by default - no automatic domain restrictions
  - DO NOT infer domain preferences from the query content (e.g., don't limit to social media for "latest news")
  - Leave allowed_domains and blocked_domains parameters UNSET (not provided) for normal searches

Search Strategy:
  - Uses DuckDuckGo search to retrieve web search results
  - May encounter CAPTCHA challenges on some searches, which will return no results
  - Try rephrasing your query if no results are returned

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`
}
