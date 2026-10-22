/**
 * Read-size limits shared by the Browser tool's read/get actions.
 *
 * Browsing is meant to be a sequence of small, targeted reads. A single call
 * is capped so it cannot flood the context, and the text one document (or one
 * browser session) may return is capped so paging a huge page cannot grow the
 * conversation without bound — the pattern that eventually trips provider
 * token/rate limits and shows up as dropped requests.
 */

/** Default characters returned when the caller does not pass maxChars. */
export const READ_DEFAULT_MAX_CHARS = 4_000

/** Hard ceiling for a single read/get call, regardless of what maxChars says. */
export const READ_MAX_CHARS_PER_CALL = 12_000

/** Floor accepted by the read/get maxChars schema. */
export const READ_MIN_CHARS = 500

/**
 * Total characters one document (same tab + URL + selector) may return across
 * paginated reads before further paging is refused. Reset by navigation or a
 * different selector.
 */
export const READ_MAX_CHARS_PER_DOCUMENT = 24_000

/**
 * Total characters the Browser tool may return through read in one browser
 * session. Past this point the model is told to use extract/get or a narrower
 * selector instead of paging more text into the conversation.
 */
export const READ_MAX_CHARS_PER_SESSION = 96_000

/** Remaining-budget value below which a read result carries a warning. */
export const READ_BUDGET_WARNING_CHARS = 4_000

/**
 * How much raw page text a summary call may feed to the small summarizer
 * model. This text stays in the tool process and never enters the main model's
 * context, so it is not charged against the read budget.
 */
export const SUMMARY_INPUT_MAX_CHARS = 60_000

/** Default length of the digest returned by a summary read. */
export const SUMMARY_DEFAULT_MAX_CHARS = 3_000

/**
 * Pages longer than this are summarized automatically instead of being paged
 * into the conversation. Mirrors WebFetch: the raw page is an input to the
 * summarizer, not something the main model reads by default.
 */
export const READ_AUTO_SUMMARY_THRESHOLD_CHARS = 20_000

/** How long a query/summary extraction stays reusable. */
export const READ_EXTRACTION_CACHE_TTL_MS = 60_000

/** Most extraction results kept per browser session. */
export const READ_EXTRACTION_CACHE_MAX_ENTRIES = 32

/**
 * Repeated query reads of the same page inside the TTL return a short stub
 * instead of the passages again: the earlier result is already in the
 * conversation, and re-sending it only grows the context.
 */
export const READ_CACHE_STUB_THRESHOLD_CHARS = 1_200

/** Characters of the earlier query result repeated in a cache stub. */
export const READ_CACHE_PREVIEW_CHARS = 400
