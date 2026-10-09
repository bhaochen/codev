/**
 * Watchdog 系统统一导出
 */

export {
  BaseWatchdog,
  WatchdogManager,
  WatchdogEventBus,
  type WatchdogConfig,
  type WatchdogEvent,
} from "./watchdog.js";

export { SecurityWatchdog, type SecurityWatchdogConfig } from "./securityWatchdog.js";
export { PermissionsWatchdog, type PermissionsWatchdogConfig } from "./permissionsWatchdog.js";
export { DownloadsWatchdog, type DownloadsWatchdogConfig } from "./downloadsWatchdog.js";
export { StorageWatchdog, type StorageWatchdogConfig } from "./storageWatchdog.js";