import React, { useState } from 'react';
import { Box, Text, useTheme } from '../ink.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { ThemePicker } from './ThemePicker.js';
import { Login } from '../commands/login/login.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';

type StepId = 'theme' | 'login';

interface LoginOnboardingStep {
  id: StepId;
  component: React.ReactNode;
}

type Props = {
  onDone(): void;
};

export function LoginOnboarding({
  onDone
}: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [theme, setTheme] = useTheme();
  const exitState = useExitOnCtrlCDWithKeybindings();

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex(prev => prev + 1);
    } else {
      onDone();
    }
  }

  function handleThemeSelection(newTheme: string) {
    setTheme(newTheme);
    goToNextStep();
  }

  const themeStep = (
    <Box marginX={1}>
      <ThemePicker 
        onThemeSelect={handleThemeSelection} 
        showIntroText={true} 
        helpText="To change this later, run /theme" 
        hideEscToCancel={true} 
        skipExitHandling={true}
      />
    </Box>
  );

  const loginStep = (
    <Box marginX={1}>
      <Login 
        onDone={(success) => {
          if (success) {
            goToNextStep();
          }
        }}
        startingMessage="Choose which provider you want Better-Clawd to use."
      />
    </Box>
  );

  const steps: LoginOnboardingStep[] = [
    {
      id: 'theme',
      component: themeStep,
    },
    {
      id: 'login',
      component: loginStep,
    },
  ];

  const currentStep = steps[currentStepIndex];

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Box flexDirection="column" gap={1}>
              <Text dimColor>Press {exitState.keyName} again to exit</Text>
              <PressEnterToContinue />
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}