/** Wire format version byte for protocol v1. */
export const PROTOCOL_VERSION = 0x01;
/** Currency byte for West African CFA franc. */
export const CURRENCY_XOF = 0x01;

export const DEVICE_SECRET_BYTES = 32;
export const DEVICE_ID_BYTES = 16;
export const SID_BYTES = 8;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const PLAINTEXT_BYTES = 13;
/** version(1) | deviceId(16) | iv(12) | ciphertext(13) | tag(16) */
export const TOKEN_BYTES =
  1 + DEVICE_ID_BYTES + IV_BYTES + PLAINTEXT_BYTES + TAG_BYTES;
/** Base64url length of a v1 token. */
export const TOKEN_CHARS = 78;
/** Any token string longer than this is rejected before decoding. */
export const MAX_TOKEN_CHARS = 256;

export const MIN_AMOUNT_XOF = 50;
export const MAX_AMOUNT_XOF = 5_000_000;
/** Largest amount the uint32 field can carry. */
export const AMOUNT_FIELD_MAX = 0xffffffff;

export const CONFIRM_CODE_DIGITS = 6;
