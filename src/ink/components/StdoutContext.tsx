import { createContext, useContext } from 'react'

export type Props = {
	readonly stdout: NodeJS.WriteStream & { readonly rows: number; readonly columns: number }
	readonly write: (data: string) => void
}

const StdoutContext = createContext<Props>({
	stdout: process.stdout as NodeJS.WriteStream & { rows: number; columns: number },
	write() {},
})

StdoutContext.displayName = 'StdoutContext'

export default StdoutContext