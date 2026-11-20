import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SAVED_ASSET } from '../shared/board'
import { MAX_ASSET_BYTES } from '../shared/bounded'
import type { ImageAsset, ImageAttachment, SentImage } from '../shared/types'
import { assetName, saveAsset } from './board-tool-workflow'

const JPEG = [0xff, 0xd8, 0xff]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The full-quality copy the composer sends with a canvas chat's image: a JPEG or PNG, as its
 * own first bytes say, under the size the composer keeps it to. Anything else isn't saved.
 */
export function isImageAsset(value: unknown): value is ImageAsset {
  if (!value || typeof value !== 'object') return false
  const { mimeType, bytes } = value as Record<string, unknown>
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ASSET_BYTES)
    return false
  const magic = mimeType === 'image/jpeg' ? JPEG : mimeType === 'image/png' ? PNG : null
  return !!magic && magic.every((byte, i) => bytes[i] === byte)
}

/** "Beach Photo.HEIC" sent as a JPEG → "beach-photo.jpg". */
export function attachedAssetName(name: string, mimeType: ImageAsset['mimeType']) {
  return assetName(name, mimeType === 'image/png' ? 'png' : 'jpg', 'image')
}

/**
 * Saves each image's full-quality copy in the canvas at `root`, under assets/, never over a
 * file already there, and says where on the image (`saved`) for the agent's prompt. An image
 * that couldn't be saved goes without: the message still goes. Nothing more is written once
 * `current` says the canvas closed.
 */
export async function saveChatImages(
  root: string,
  images: SentImage[],
  current: () => boolean,
): Promise<ImageAttachment[]> {
  const dir = join(root, 'assets')
  const out: ImageAttachment[] = []
  // One at a time: two images with the same name become name and name-2, in order.
  for (const { asset, ...image } of images) {
    let saved: string | null = null
    if (asset && current()) {
      try {
        await mkdir(dir, { recursive: true })
        if (current()) {
          const data = Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.length)
          saved = `assets/${await saveAsset(dir, attachedAssetName(image.name, asset.mimeType), data)}`
        }
      } catch {
        saved = null
      }
    }
    out.push(saved ? { ...image, saved } : image)
  }
  return out
}

/** Removes what `saveChatImages` saved for a message that then didn't go. */
export async function discardChatImages(root: string, images: ImageAttachment[]) {
  await Promise.all(
    images.flatMap(({ saved }) =>
      saved && SAVED_ASSET.test(saved) ? [rm(join(root, saved), { force: true })] : [],
    ),
  )
}
