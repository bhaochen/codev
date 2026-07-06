import { useContext } from 'react'
import { useAccessibility } from '../components/AccessibilityContext.js'

/**
 * Hook that returns whether a screen reader is enabled.
 * Useful when components need to render different output for screen readers.
 */
export default function useIsScreenReaderEnabled(): boolean {
	const { isScreenReaderEnabled } = useAccessibility()
	return isScreenReaderEnabled
}