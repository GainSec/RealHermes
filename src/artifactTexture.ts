import { LinearFilter, SRGBColorSpace, Texture } from 'three'
import type { ArtifactView } from './artifact'
import { artifactPageUrl } from './artifact'
export async function loadArtifactTexture(view: ArtifactView, signal: AbortSignal, fetcher: typeof fetch = fetch, decode: typeof createImageBitmap = createImageBitmap): Promise<Texture> {
  if (!/^[a-f0-9]{32}$/.test(view.id) || !Number.isInteger(view.page) || view.page < 1 || view.page > view.pageCount || view.pageCount > 500) throw new Error('Invalid artifact page')
  const response = await fetcher(artifactPageUrl(view), { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(response.headers.get('content-type') ?? '')) throw new Error('Page unavailable')
  const image = await decode(await response.blob(), { imageOrientation: 'flipY' })
  if (signal.aborted || image.width < 1 || image.height < 1 || image.width > 8192 || image.height > 8192 || image.width * image.height > 16_000_000) { image.close(); throw new Error('Page unavailable') }
  const texture = new Texture(image)
  texture.colorSpace = SRGBColorSpace; texture.minFilter = LinearFilter; texture.generateMipmaps = false; texture.needsUpdate = true
  texture.addEventListener('dispose', () => image.close())
  return texture
}
