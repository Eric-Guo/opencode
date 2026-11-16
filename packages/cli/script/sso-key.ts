export function ssoKey() {
  const key = process.env.SIGMA_AES_128_ECB_KEY
  if (!key || Buffer.byteLength(key, "utf8") !== 16)
    throw new Error("SIGMA_AES_128_ECB_KEY must contain exactly 16 UTF-8 bytes in the build environment")

  return key
}
