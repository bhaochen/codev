import { createContext, useContext } from 'react'

type AccessibilityContextValue = {
	readonly isScreenReaderEnabled: boolean
}

const AccessibilityContext = createContext<AccessibilityContextValue>({
	isScreenReaderEnabled: false,
})

AccessibilityContext.displayName = 'AccessibilityContext'

export default AccessibilityContext

export function useAccessibility(): AccessibilityContextValue {
	return useContext(AccessibilityContext)
}
