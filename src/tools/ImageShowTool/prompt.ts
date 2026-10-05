export const IMAGE_SHOW_TOOL_NAME = 'ImageShow'

export const DESCRIPTION = `
ImageShow — Display images directly in the terminal transcript.

This tool renders PNG/JPEG/GIF/WebP images inline, above a one-line summary. It supports both local file paths and HTTPS URLs.

**When to use this tool:**
- User asks to display, view, or show an image
- Search results include image thumbnails that should be displayed inline
- User references a local image path or URL and wants to see it
- Any situation where visual inspection of an image is helpful

**Input:**
- \`src\`: Image source — either a local file path (e.g. \`/home/user/pic.png\`) or a HTTPS URL (e.g. \`https://example.com/image.jpg\`)

**Supported formats:** PNG, JPEG, GIF, WebP

**Usage examples:**
- Display a local image: \`src: "/home/user/Pictures/wallpaper.jpg"\`
- Display a remote image: \`src: "https://example.com/photo.png"\`
- Display Google Street View: \`src: "https://maps.googleapis.com/maps/api/streetview?size=800x400&location=37.7749,-122.4194&key=..."\`

**Rendering details:**
- The image is sized to fit the terminal window while preserving aspect ratio, up to about 75% of its height so the prompt and summary line stay on screen.
- On terminals with a graphics protocol (Kitty, Ghostty, WezTerm, Konsole, iTerm2, or a sixel-capable terminal) the image is drawn with real pixels. Elsewhere it falls back to a Unicode block-glyph rendering, which needs only 24-bit or 256-color support.
- Either way the summary line stays visible, so a terminal that cannot show the picture still reports what it was.
- Set \`CODEV_INLINE_IMAGES=off\` to disable inline images, or \`inlineImagesEnabled: false\` in settings.

**Combining with other tools:**
- WebSearch results with images → ImageShow displays them inline automatically
- LocationTool place photos → ImageShow renders them
- WebFetchTool image URLs → ImageShow displays the fetched content
`
