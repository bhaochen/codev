import { Jimp } from "jimp";

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
]);

export async function loadImageFromUrl(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "image/jpeg, image/png, image/gif, image/bmp, image/tiff, image/webp, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();

  if (mime && !SUPPORTED_MIME_TYPES.has(mime)) {
    throw new Error(
      `Unsupported image format: ${mime}. Supported: ${[...SUPPORTED_MIME_TYPES].join(", ")}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return Jimp.read(buffer);
}
