// Formats Claude accepts as image input; anything else the browser can decode is
// converted to PNG first.
const NATIVE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

export const imageUrl = (path: string) => `canvas-image://local/${encodeURIComponent(path.split('/').pop()!)}`

export function hasImageFiles(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.items].some((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

async function toPng(file: File): Promise<ArrayBuffer | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    return await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
  } catch {
    return null
  }
}

/** Copy dropped or pasted image files into the app's images folder; returns their paths. */
export async function importImages(files: Iterable<File>): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const ext = NATIVE[file.type]
    const data = ext ? await file.arrayBuffer() : await toPng(file)
    if (data) paths.push(await window.canvas.saveImage(data, ext ?? 'png'))
  }
  return paths
}
