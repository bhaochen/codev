import { useContext } from 'react'
import StdoutContext from '../components/StdoutContext.js'

/**
 * A React hook that returns the stdout stream where Ink renders your app,
 * plus a `write` function for emitting raw data to stdout outside of Ink's
 * normal render loop (e.g. for inline image protocols).
 */
export default function useStdout() {
	return useContext(StdoutContext)
}
