import { createContext, useContext } from 'react'

export type Props = {
	readonly stdout: NodeJS.WriteStream & { readonly rows: number; readonly columns: number }
	/**
	 * Write any string to stdout while preserving Ink's output.
	 * Useful for emitting raw escape sequences (e.g. image protocols)
	 * outside of Ink's normal render loop.
	 */
	readonly write: (data: string) => void
}

const StdoutContext = createContext<Props>({
	stdout: process.stdout as NodeJS.WriteStream & { rows: number; columns: number },
	write() {},
})

StdoutContext.displayName = 'StdoutContext'

export default StdoutContext

export function useStdout(): Props {
	return useContext(StdoutContext)
}
