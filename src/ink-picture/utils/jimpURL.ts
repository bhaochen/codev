export async function loadImageFromUrl(url: string): Promise<Jimp> {
  // 请求时指定只接受 Jimp 支持的格式
  const response = await fetch(url, {
    headers: {
      'Accept': 'image/jpeg, image/png, image/gif, image/bmp, image/tiff, */*'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return Jimp.read(buffer);
}
