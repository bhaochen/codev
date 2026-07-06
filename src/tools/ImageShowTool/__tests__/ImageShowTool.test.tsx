import { describe, it, expect } from 'vitest';
import { ImageShowTool } from '../ImageShowTool';

// Remote image test to verify ImageShowTool loading and rendering logic
describe('ImageShowTool', () => {
  it('loads and processes a remote image successfully', async () => {
    const url = 'https://upload.wikimedia.org/wikipedia/en/7/7d/Lenna_%28test_image%29.png';
    const result = await ImageShowTool.call({ url });
    expect(result.data.success).toBe(true);
    // Ensure the returned data includes image dimensions
    expect(typeof result.data.naturalWidth).toBe('number');
    expect(typeof result.data.naturalHeight).toBe('number');
    // Base64 representation should be present
    expect(typeof result.data.base64).toBe('string');
  });
});
