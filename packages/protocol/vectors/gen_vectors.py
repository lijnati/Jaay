"""Independent reference for protocol v1 (D1 to D3), using pyca/cryptography.

Run: python vectors/gen_vectors.py > vectors/v1.json
The TypeScript tests load v1.json and must reproduce every value.
"""
import base64
import hashlib
import hmac
import json

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def hkdf(secret: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"jaay/v1/salt", info=info).derive(secret)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


secret = bytes(range(32))
device_id = bytes(range(0x40, 0x50))
iv = bytes(range(0xA0, 0xAC))
amount = 2500
sid = bytes.fromhex("0011223344556677")

enc = hkdf(secret, b"jaay/v1/enc")
code_key = hkdf(secret, b"jaay/v1/code")
auth = hkdf(secret, b"jaay/v1/auth")

version = b"\x01"
plaintext = amount.to_bytes(4, "big") + sid + b"\x01"
aad = version + device_id
token = version + device_id + iv + AESGCM(enc).encrypt(iv, plaintext, aad)

codes = []
for i in range(5):
    s = hashlib.sha256(b"sid" + bytes([i])).digest()[:8]
    n = int.from_bytes(hmac.new(code_key, s, hashlib.sha256).digest()[:8], "big") % 1_000_000
    codes.append({"sid": b64u(s), "code": f"{n:06d}"})

print(json.dumps({
    "secret": b64u(secret),
    "deviceId": b64u(device_id),
    "iv": b64u(iv),
    "amountXof": amount,
    "sid": b64u(sid),
    "token": b64u(token),
    "authHmacOfTest": b64u(hmac.new(auth, b"test", hashlib.sha256).digest()),
    "codes": codes,
}, indent=2))
