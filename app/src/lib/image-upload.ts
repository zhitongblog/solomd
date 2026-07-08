/**
 * Image-upload (图床 / external image hosting) helpers.
 *
 * Translates the flat `imageUploader*` / `s3*` / `ghImage*` settings into the
 * tagged `UploaderConfig` object that the Rust `upload_image` command expects,
 * and wraps the actual invoke. Mirrors Typora / MarkText: a pasted, dropped or
 * picked image is uploaded to a host and the returned URL is inserted instead
 * of (or alongside) a local copy.
 *
 * The Rust side (`src-tauri/src/image_upload.rs`) deserializes the `config`
 * with `#[serde(tag = "kind")]`, so the `kind` field selects the backend and
 * the remaining fields are backend-specific (camelCase).
 */

import { invoke } from '@tauri-apps/api/core';

export type UploaderKind = 'none' | 'picgo' | 'command' | 'smms' | 's3' | 'github';

/** The structural subset of the settings store this module reads. Declared
 *  locally (not imported) to avoid a store↔lib import cycle. */
export interface ImageUploadSettings {
  imageUploader: UploaderKind;
  imageUploadOnPaste: boolean;
  imageUploadKeepLocal: boolean;
  picgoEndpoint: string;
  imageUploadCommand: string;
  smmsToken: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathPrefix: string;
  s3CustomDomain: string;
  s3UsePathStyle: boolean;
  ghImageRepo: string;
  ghImageBranch: string;
  ghImageToken: string;
  ghImagePathPrefix: string;
  ghImageCdn: 'raw' | 'jsdelivr';
}

/** Tagged config forwarded to the Rust command. `kind` picks the backend. */
export type UploaderConfig =
  | { kind: 'picgo'; endpoint: string }
  | { kind: 'command'; command: string }
  | { kind: 'smms'; token: string }
  | {
      kind: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      key: string;
      customDomain: string;
      usePathStyle: boolean;
    }
  | { kind: 'github'; repo: string; branch: string; token: string; key: string; cdn: string };

export interface ResolvedUploader {
  cfg: UploaderConfig;
  onPaste: boolean;
  keepLocal: boolean;
}

/** Normalize a key prefix: drop leading slashes, ensure a single trailing
 *  slash when non-empty (so `prefix + filename` is a clean object key). */
function normPrefix(p: string): string {
  const t = (p || '').replace(/^[/\\]+/, '').replace(/[\\]/g, '/').trim();
  if (!t) return '';
  return t.endsWith('/') ? t : t + '/';
}

/**
 * Build the uploader config for a given target filename, or `null` when no
 * uploader is configured (`imageUploader === 'none'`) or the chosen backend is
 * missing required fields (so callers cleanly fall back to local saving).
 *
 * `filename` is the basename to use as the remote object key (s3 / github).
 */
export function resolveUploader(
  s: ImageUploadSettings,
  filename: string,
): ResolvedUploader | null {
  const base = { onPaste: !!s.imageUploadOnPaste, keepLocal: !!s.imageUploadKeepLocal };
  switch (s.imageUploader) {
    case 'picgo': {
      const endpoint = (s.picgoEndpoint || '').trim();
      if (!endpoint) return null;
      return { cfg: { kind: 'picgo', endpoint }, ...base };
    }
    case 'command': {
      const command = (s.imageUploadCommand || '').trim();
      if (!command) return null;
      return { cfg: { kind: 'command', command }, ...base };
    }
    case 'smms':
      return { cfg: { kind: 'smms', token: (s.smmsToken || '').trim() }, ...base };
    case 's3': {
      if (!s.s3Bucket || !s.s3AccessKeyId || !s.s3SecretAccessKey || !s.s3Endpoint) return null;
      return {
        cfg: {
          kind: 's3',
          endpoint: s.s3Endpoint.trim().replace(/\/+$/, ''),
          region: (s.s3Region || 'us-east-1').trim(),
          bucket: s.s3Bucket.trim(),
          accessKeyId: s.s3AccessKeyId.trim(),
          secretAccessKey: s.s3SecretAccessKey.trim(),
          key: normPrefix(s.s3PathPrefix) + filename,
          customDomain: (s.s3CustomDomain || '').trim().replace(/\/+$/, ''),
          usePathStyle: !!s.s3UsePathStyle,
        },
        ...base,
      };
    }
    case 'github': {
      if (!s.ghImageRepo || !s.ghImageToken) return null;
      return {
        cfg: {
          kind: 'github',
          repo: s.ghImageRepo.trim().replace(/^\/+|\/+$/g, ''),
          branch: (s.ghImageBranch || 'main').trim(),
          token: s.ghImageToken.trim(),
          key: normPrefix(s.ghImagePathPrefix) + filename,
          cdn: s.ghImageCdn === 'raw' ? 'raw' : 'jsdelivr',
        },
        ...base,
      };
    }
    default:
      return null;
  }
}

/** Whether an uploader is configured at all (used to gate menu items / cmds). */
export function hasUploader(s: ImageUploadSettings): boolean {
  return s.imageUploader !== 'none';
}

/** Invoke the Rust uploader. Resolves to the hosted URL; rejects with a
 *  human-readable message on failure. */
export async function uploadImage(cfg: UploaderConfig, path: string): Promise<string> {
  const url = await invoke<string>('upload_image', { config: cfg, path });
  if (!url || typeof url !== 'string') throw new Error('empty url');
  return url.trim();
}
