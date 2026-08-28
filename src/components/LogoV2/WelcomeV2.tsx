import React from 'react'
import { Box, Text, useTheme } from 'src/ink.js'
import { env } from '../../utils/env.js'
import { CLAWD_GRADIENT_STOPS } from './Clawd.js'
import { interpolateColor, parseRGB, toRGBColor } from '../Spinner/utils.js'

const WELCOME_V2_WIDTH = 58

// Cool Morandi gradient stops shared with the animated Clawd mascot: icy
// silver → muted slate → midnight blue. Industrial, cold, restrained.
const CLAWD_STOPS = CLAWD_GRADIENT_STOPS.map(s => parseRGB(s)).filter(
  (s): s is NonNullable<ReturnType<typeof parseRGB>> => s !== null,
)

// Sample the gradient at t∈[0,1].
function sampleClawdGradient(t: number) {
  const clamped = Math.min(1, Math.max(0, t))
  const seg = clamped * (CLAWD_STOPS.length - 1)
  const i = Math.min(CLAWD_STOPS.length - 2, Math.floor(seg))
  const f = seg - i
  return interpolateColor(CLAWD_STOPS[i]!, CLAWD_STOPS[i + 1]!, f)
}

// Color a single Clawd-figure row with a top→bottom silver→midnight gradient
// (subtle diagonal sweep for an industrial, cold, restrained high-end feel).
// rowIndex: 0 = top body, 1 = mid body, 2 = bottom body, 3 = eyes.
function gradientClawdRow(text: string, rowIndex: number): React.ReactNode {
  const totalRows = 4
  const cells: React.ReactNode[] = []
  for (let x = 0; x < text.length; x++) {
    const ch = text[x]!
    if (ch === ' ') {
      cells.push(' ')
      continue
    }
    const t = (rowIndex + x / Math.max(1, text.length)) / totalRows
    cells.push(<Text key={x} color={toRGBColor(sampleClawdGradient(t))}>{ch}</Text>)
  }
  return <Text>{cells}</Text>
}

export function WelcomeV2(): React.ReactNode {
  const [theme] = useTheme()
  const welcomeMessage = 'Welcome to Codev'

  if (env.terminal === 'Apple_Terminal') {
    return (
      <AppleTerminalWelcomeV2 theme={theme} welcomeMessage={welcomeMessage} />
    )
  }

  if (['light', 'light-daltonized', 'light-ansi'].includes(theme)) {
    return (
      <Box width={WELCOME_V2_WIDTH}>
        <Text>
          <Text>
            <Text color="clawd_body">{welcomeMessage} </Text>
            <Text dimColor>v{MACRO.VERSION} </Text>
          </Text>
          <Text>
            {'…………………………………………………………………………………………………………………………………………………………'}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'            ░░░░░░                                        '}
          </Text>
          <Text>
            {'    ░░░   ░░░░░░░░░░                                      '}
          </Text>
          <Text>
            {'   ░░░░░░░░░░░░░░░░░░░                                    '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            <Text dimColor>{'                           ░░░░'}</Text>
            <Text>{'                     ██    '}</Text>
          </Text>
          <Text>
            <Text dimColor>{'                         ░░░░░░░░░░'}</Text>
            <Text>{'               ██▒▒██  '}</Text>
          </Text>
          <Text>
            {'                                            ▒▒      ██   ▒'}
          </Text>
          <Text>
            {'      '}
            <Text>{gradientClawdRow(' █████████ ', 0)}</Text>
            {'                         ▒▒░░▒▒      ▒ ▒▒'}
          </Text>
          <Text>
            {'      '}
            <Text>{gradientClawdRow('██▄█████▄██', 1)}</Text>
            {'                           ▒▒         ▒▒ '}
          </Text>
          <Text>
            {'      '}
            <Text>{gradientClawdRow(' █████████ ', 2)}</Text>
            {'                          ░          ▒   '}
          </Text>
          <Text>
            {'…………………'}
            <Text>{gradientClawdRow('█ █   █ █', 3)}</Text>
            {'……………………………………………………………………░…………………………▒…………'}
          </Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box width={WELCOME_V2_WIDTH}>
      <Text>
        <Text>
          <Text color="clawd_body">{welcomeMessage} </Text>
          <Text dimColor>v{MACRO.VERSION} </Text>
        </Text>
        <Text>
          {'…………………………………………………………………………………………………………………………………………………………'}
        </Text>
        <Text>
          {'                                                          '}
        </Text>
        <Text>
          {'     *                                       █████▓▓░     '}
        </Text>
        <Text>
          {'                                 *         ███▓░     ░░   '}
        </Text>
        <Text>
          {'            ░░░░░░                        ███▓░           '}
        </Text>
        <Text>
          {'    ░░░   ░░░░░░░░░░                      ███▓░           '}
        </Text>
        <Text>
          <Text>{'   ░░░░░░░░░░░░░░░░░░░    '}</Text>
          <Text bold>*</Text>
          <Text>{'                ██▓░░      ▓   '}</Text>
        </Text>
        <Text>
          {'                                             ░▓▓███▓▓░    '}
        </Text>
        <Text dimColor>
          {' *                                 ░░░░                   '}
        </Text>
        <Text dimColor>
          {'                                 ░░░░░░░░                 '}
        </Text>
        <Text dimColor>
          {'                               ░░░░░░░░░░░░░░░░           '}
        </Text>
        <Text>
          {'      '}
          <Text>{gradientClawdRow(' █████████ ', 0)}</Text>
          {'                                       '}
          <Text dimColor>*</Text>
          <Text> </Text>
        </Text>
        <Text>
          {'      '}
          <Text>{gradientClawdRow('██▄█████▄██', 1)}</Text>
          <Text>{'                        '}</Text>
          <Text bold>*</Text>
          <Text>{'                '}</Text>
        </Text>
        <Text>
          {'      '}
          <Text>{gradientClawdRow(' █████████ ', 2)}</Text>
          {'     *                                   '}
        </Text>
        <Text>
          {'…………………'}
          <Text>{gradientClawdRow('█ █   █ █', 3)}</Text>
          {'………………………………………………………………………………………………………………'}
        </Text>
      </Text>
    </Box>
  )
}

type AppleTerminalWelcomeV2Props = {
  theme: string
  welcomeMessage: string
}

function AppleTerminalWelcomeV2({
  theme,
  welcomeMessage,
}: AppleTerminalWelcomeV2Props): React.ReactNode {
  const isLightTheme = ['light', 'light-daltonized', 'light-ansi'].includes(
    theme,
  )

  if (isLightTheme) {
    return (
      <Box width={WELCOME_V2_WIDTH}>
        <Text>
          <Text>
            <Text color="clawd_body">{welcomeMessage} </Text>
            <Text dimColor>v{MACRO.VERSION} </Text>
          </Text>
          <Text>
            {'…………………………………………………………………………………………………………………………………………………………'}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            {'            ░░░░░░                                        '}
          </Text>
          <Text>
            {'    ░░░   ░░░░░░░░░░                                      '}
          </Text>
          <Text>
            {'   ░░░░░░░░░░░░░░░░░░░                                    '}
          </Text>
          <Text>
            {'                                                          '}
          </Text>
          <Text>
            <Text dimColor>{'                           ░░░░'}</Text>
            <Text>{'                     ██    '}</Text>
          </Text>
          <Text>
            <Text dimColor>{'                         ░░░░░░░░░░'}</Text>
            <Text>{'               ██▒▒██  '}</Text>
          </Text>
          <Text>
            {'                                            ▒▒      ██   ▒'}
          </Text>
          <Text>
            {'                                          ▒▒░░▒▒      ▒ ▒▒'}
          </Text>
          <Text>
            {'      '}
            <Text color="clawd_body">▗</Text>
            <Text color="clawd_background" backgroundColor="clawd_body">
              {' '}
              ▗{'     '}▖{' '}
            </Text>
            <Text color="clawd_body">▖</Text>
            {'                           ▒▒         ▒▒ '}
          </Text>
          <Text>
            {'       '}
            <Text backgroundColor="clawd_body">{' '.repeat(9)}</Text>
            {'                           ░          ▒   '}
          </Text>
          <Text>
            {'…………………'}
            <Text backgroundColor="clawd_body"> </Text>
            <Text> </Text>
            <Text backgroundColor="clawd_body"> </Text>
            <Text>{'   '}</Text>
            <Text backgroundColor="clawd_body"> </Text>
            <Text> </Text>
            <Text backgroundColor="clawd_body"> </Text>
            {'……………………………………………………………………░…………………………▒…………'}
          </Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box width={WELCOME_V2_WIDTH}>
      <Text>
        <Text>
          <Text color="clawd_body">{welcomeMessage} </Text>
          <Text dimColor>v{MACRO.VERSION} </Text>
        </Text>
        <Text>
          {'…………………………………………………………………………………………………………………………………………………………'}
        </Text>
        <Text>
          {'                                                          '}
        </Text>
        <Text>
          {'     *                                       █████▓▓░     '}
        </Text>
        <Text>
          {'                                 *         ███▓░     ░░   '}
        </Text>
        <Text>
          {'            ░░░░░░                        ███▓░           '}
        </Text>
        <Text>
          {'    ░░░   ░░░░░░░░░░                      ███▓░           '}
        </Text>
        <Text>
          <Text>{'   ░░░░░░░░░░░░░░░░░░░    '}</Text>
          <Text bold>*</Text>
          <Text>{'                ██▓░░      ▓   '}</Text>
        </Text>
        <Text>
          {'                                             ░▓▓███▓▓░    '}
        </Text>
        <Text dimColor>
          {' *                                 ░░░░                   '}
        </Text>
        <Text dimColor>
          {'                                 ░░░░░░░░                 '}
        </Text>
        <Text dimColor>
          {'                               ░░░░░░░░░░░░░░░░           '}
        </Text>
        <Text>
          {'                                                      '}
          <Text dimColor>*</Text>
          <Text> </Text>
        </Text>
        <Text>
          {'        '}
          <Text color="clawd_body">▗</Text>
          <Text color="clawd_background" backgroundColor="clawd_body">
            {' '}
            ▗{'     '}▖{' '}
          </Text>
          <Text color="clawd_body">▖</Text>
          <Text>{'                       '}</Text>
          <Text bold>*</Text>
          <Text>{'                '}</Text>
        </Text>
        <Text>
          {'        '}
          <Text backgroundColor="clawd_body">{' '.repeat(9)}</Text>
          {'      *                                   '}
        </Text>
        <Text>
          {'…………………'}
          <Text backgroundColor="clawd_body"> </Text>
          <Text> </Text>
          <Text backgroundColor="clawd_body"> </Text>
          <Text>{'   '}</Text>
          <Text backgroundColor="clawd_body"> </Text>
          <Text> </Text>
          <Text backgroundColor="clawd_body"> </Text>
          {'………………………………………………………………………………………………………………'}
        </Text>
      </Text>
    </Box>
  )
}
