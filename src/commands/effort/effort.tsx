import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { Box, Text } from '../../ink.js';
import { Pane } from '../../components/design-system/Pane.js';
import { Select } from '../../components/CustomSelect/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortLevel, type EffortValue, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, getModelSupportedEfforts, isEffortLevel, toPersistableEffort } from '../../utils/effort.js';
import { effortLevelToSymbol } from '../../components/EffortIndicator.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined ? '' : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: {
      value: undefined
    }
  };
}
export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel();
  }
  if (!isEffortLevel(normalized)) {
    return {
      message: `Invalid argument: ${args}. Valid options are: minimal, low, medium, high, xhigh, max, auto`
    };
  }
  return setEffortValue(normalized);
}
function EffortLevelSymbol(t0) {
  const $ = _c(4);
  const {
    level
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = effortLevelToSymbol(level);
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Text color="suggestion">{t1}</Text>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
function EffortOptionLabel(t0) {
  const $ = _c(5);
  const {
    level,
    text
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = <EffortLevelSymbol level={level} />;
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1 || $[3] !== text) {
    t2 = <>{t1} {text}</>;
    $[2] = t1;
    $[3] = text;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}
function EffortPicker(t0) {
  const $ = _c(16);
  const {
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const model = useMainLoopModel();
  const supportedLevels = getModelSupportedEfforts(model);
  const allOptions = [{
    label: <Text>Auto</Text>,
    value: "auto",
    description: "Default effort level for your model"
  }, {
    label: <EffortOptionLabel level="minimal" text="Minimal" />,
    value: "minimal",
    description: "Minimal thinking \u2014 fastest responses for simple tasks"
  }, {
    label: <EffortOptionLabel level="low" text="Low" />,
    value: "low",
    description: "Quick, straightforward implementation"
  }, {
    label: <EffortOptionLabel level="medium" text="Medium" />,
    value: "medium",
    description: "Balanced approach with standard testing"
  }, {
    label: <EffortOptionLabel level="high" text="High" />,
    value: "high",
    description: "Comprehensive implementation with extensive testing"
  }, {
    label: <EffortOptionLabel level="xhigh" text="Extra High" />,
    value: "xhigh",
    description: "Extra high effort \u2014 deeper reasoning for complex tasks"
  }, {
    label: <EffortOptionLabel level="max" text="Max" />,
    value: "max",
    description: "Maximum capability with deepest reasoning (supported models only)"
  }];
  const options = allOptions.filter(o => o.value === 'auto' || supportedLevels.includes(o.value as EffortLevel));
  let t2;
  if ($[1] !== onDone || $[2] !== setAppState) {
    t2 = value => {
      const result = value === "auto" ? unsetEffortLevel() : setEffortValue(value);
      if (result.effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: result.effortUpdate.value
        }));
      }
      onDone(result.message);
    };
    $[1] = onDone;
    $[2] = setAppState;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleSelect = t2;
  let t3;
  if ($[4] !== onDone) {
    t3 = () => {
      onDone("");
    };
    $[4] = onDone;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const handleCancel = t3;
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text bold>Select effort level</Text>;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text dimColor={true}>Arrow keys to navigate, Enter to select, Esc to cancel</Text>;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] !== options || $[9] !== handleSelect || $[10] !== handleCancel) {
    t6 = <Pane color="permission"><Box flexDirection="column"><Box marginBottom={1} flexDirection="column">{t4}{t5}</Box><Select options={options} onChange={handleSelect} onCancel={handleCancel} visibleOptionCount={7} /></Box></Pane>;
    $[8] = options;
    $[9] = handleSelect;
    $[10] = handleCancel;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  return t6;
}
function ShowCurrentEffort(t0) {
  const $ = _c(4);
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Usage: /effort [minimal|low|medium|high|xhigh|max|auto]\n\nEffort levels:\n- minimal: Minimal thinking \u2014 fastest responses for simple tasks\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- xhigh: Extra high effort \u2014 deeper reasoning for complex tasks\n- max: Maximum capability with deepest reasoning (supported models only)\n- auto: Use the default effort level for your model');
    return;
  }
  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  if (!args) {
    return <EffortPicker onDone={onDone} />;
  }
  const result = executeEffort(args);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}
