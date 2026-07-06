import { Box, type DOMElement, Newline, Text } from "src/ink";
import React, { forwardRef } from "react";

export interface ImageBoxProps {
  width: number | string;
  height: number | string;      // 总高度（占位）
  imageHeight?: number;          // 图片实际像素高度（新增）
  alt?: string;
  error?: boolean;
  loaded?: boolean;
  children?: React.ReactNode;
}

const ImageBox = forwardRef<DOMElement, ImageBoxProps>(function ImageBox(
  { width, height, imageHeight, alt, error, loaded, children },
  ref,
) {
  // 计算图片占用的字符行数
  const charHeight = typeof imageHeight === 'number'
    ? Math.ceil(imageHeight / 16)  // 像素转字符行
    : height;

  return (
    <Box ref={ref} flexDirection="column" width={width} height={loaded ? charHeight : height}>
      {loaded && children ? (
        children
      ) : (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          overflow="hidden"
        >
          {alt ? (
            <Text color="gray">{alt}</Text>
          ) : error ? (
            <Text color="red">
              X<Newline />
              Load failed
            </Text>
          ) : (
            <Text color="gray">Loading...</Text>
          )}
        </Box>
      )}
    </Box>
  );
});

export default ImageBox;
