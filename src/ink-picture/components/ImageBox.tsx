import { Box, type DOMElement, Newline, Text } from "src/ink";
import React, { forwardRef } from "react";

export interface ImageBoxProps {
  width: number | string;
  height: number | string;      // 字符高度（占位）
  alt?: string;
  error?: boolean;
  loaded?: boolean;
  children?: React.ReactNode;
}

const ImageBox = forwardRef<DOMElement, ImageBoxProps>(function ImageBox(
  { width, height, alt, error, loaded, children },
  ref,
) {
  return (
    <Box ref={ref} flexDirection="column" width={width} height={height}>
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
