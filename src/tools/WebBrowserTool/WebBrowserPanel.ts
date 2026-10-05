/**
 * The interactive browser panel is optional. The dependency-free
 * WebBrowserTool still works without a native embedded browser, but the REPL
 * mounts this component whenever WEB_BROWSER_TOOL is compiled in. Export a
 * real component so that optional browser support never hands React an
 * undefined element type.
 */
export function WebBrowserPanel(): null {
  return null
}
