/**
 * Web file picker utility — replaces Tauri's invoke('pick_*_file').
 * Opens a hidden <input type="file"> and returns the selected File or null.
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      resolve(file)
      document.body.removeChild(input)
    })
    input.addEventListener('cancel', () => {
      resolve(null)
      document.body.removeChild(input)
    })
    document.body.appendChild(input)
    input.click()
  })
}
