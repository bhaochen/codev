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
