/**
 * Hashing off the main thread. The file or text is read and hashed inside this worker, on this
 * device; the page receives only the digests. Nothing is kept after the reply is sent.
 */
import '../util-shared/worker-lockdown';
import { digest, digestText, HASHES, hmac, HMAC_HASHES, MAX_HASH_BYTES, type DigestText } from '../../core/crypto/digest';
import { serve } from '../util-shared/worker-host';

export type HashRequest = {
  readonly source: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'file'; readonly file: File };
  /** Null for plain hashes; the key bytes for HMAC. */
  readonly key: Uint8Array | null;
};

export interface HashRow {
  readonly id: string;
  readonly label: string;
  readonly caution: string | null;
  /** Null when the algorithm could not be computed here, with the reason in `unavailable`. */
  readonly digest: DigestText | null;
  readonly unavailable: string | null;
}

export interface HashReply {
  readonly bytes: number;
  readonly rows: readonly HashRow[];
}

const NO_SUBTLE = 'Needs the Web Crypto API, which browsers provide only on HTTPS or localhost.';

serve<HashRequest, HashReply>(async request => {
  const data = request.source.kind === 'text'
    ? new TextEncoder().encode(request.source.text)
    : new Uint8Array(await request.source.file.arrayBuffer());
  if (data.length > MAX_HASH_BYTES) throw new Error('The input is larger than the limit.');
  const subtle = (self as unknown as { crypto?: Crypto }).crypto?.subtle;
  const rows: HashRow[] = [];
  if (request.key) {
    for (const h of HMAC_HASHES) {
      rows.push(subtle
        ? { id: h.label, label: h.label, caution: null, digest: digestText(await hmac(subtle, h.id, request.key, data)), unavailable: null }
        : { id: h.label, label: h.label, caution: null, digest: null, unavailable: NO_SUBTLE });
    }
  } else {
    for (const h of HASHES) {
      if (h.id !== 'MD5' && !subtle) rows.push({ id: h.id, label: h.label, caution: h.caution, digest: null, unavailable: NO_SUBTLE });
      else rows.push({ id: h.id, label: h.label, caution: h.caution, digest: digestText(await digest(subtle!, h.id, data)), unavailable: null });
    }
  }
  return { bytes: data.length, rows };
});
