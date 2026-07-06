export const IMAGE_SHOW_TOOL_NAME = 'ImageShow'

export const DESCRIPTION = `
ImageShow — Display images directly in the terminal.

This tool renders PNG/JPEG/GIF/WebP images in the terminal using Kitty sixel protocol via ink-picture. It supports both local file paths and HTTPS URLs.

**When to use this tool:**
- User asks to display, view, or show an image
- Search results include image thumbnails that should be displayed inline
- User references a local image path or URL and wants to see it
- Any situation where visual inspection of an image is helpful

**Input:**
- \`src\`: Image source — either a local file path (e.g. \`/home/user/pic.png\`) or a HTTPS URL (e.g. \`https://example.com/image.jpg\`)

**Supported formats:** PNG, JPEG, GIF, WebP

**Usage examples:**
- Display a local image: \`src: "/home/yuki/Pictures/wallpaper.jpg"\`
- Display a remote image: \`src: "https://example.com/photo.png"\`
- Display Google Street View: \`src: "https://maps.googleapis.com/maps/api/streetview?size=800x400&location=37.7749,-122.4194&key=..."\`

**Rendering details:**
- Image width is auto-calculated as ~16.18% of terminal width (golden ratio)
- Height is derived from aspect ratio, with a minimum of 3 character cells
- Supports sixel-capable terminals (Kitty, WezTerm, etc.)

**Combining with other tools:**
- WebSearch results with images → ImageShow displays them inline automatically
- LocationTool place photos → ImageShow renders them
- WebFetchTool image URLs → ImageShow displays the fetched content
`