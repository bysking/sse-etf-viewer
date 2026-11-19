import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { encrypt, decrypt, hasEncryptionKey, isEncrypted } from './crypto.js'

const ORIGINAL = process.env.APP_SECRET_KEY

after(() => {
  if (ORIGINAL === undefined) delete process.env.APP_SECRET_KEY
  else process.env.APP_SECRET_KEY = ORIGINAL
})

test('未配置 APP_SECRET_KEY 时 encrypt 返回 null（不假装加密）', () => {
  delete process.env.APP_SECRET_KEY
  assert.equal(hasEncryptionKey(), false)
  assert.equal(encrypt('secret'), null)
})

test('配置密钥后加密可逆，且同一明文每次密文不同', () => {
  process.env.APP_SECRET_KEY = 'test-secret-key-123'
  assert.equal(hasEncryptionKey(), true)
  const a = encrypt('sk-very-secret')
  const b = encrypt('sk-very-secret')
  assert.ok(isEncrypted(a))
  assert.notEqual(a, b, '随机 IV 应让密文不同')
  assert.equal(decrypt(a), 'sk-very-secret')
  assert.equal(decrypt(b), 'sk-very-secret')
  assert.ok(!a.includes('sk-very-secret'), '密文不应包含明文')
})

test('兼容历史明文：非加密前缀原样返回', () => {
  process.env.APP_SECRET_KEY = 'test-secret-key-123'
  assert.equal(decrypt('legacy-plain-key'), 'legacy-plain-key')
  assert.equal(isEncrypted('legacy-plain-key'), false)
})

test('空值处理', () => {
  process.env.APP_SECRET_KEY = 'test-secret-key-123'
  assert.equal(encrypt(''), null)
  assert.equal(encrypt(null), null)
  assert.equal(decrypt(''), '')
  assert.equal(decrypt(null), '')
})

test('密钥错误时解密失败返回空串而不是抛错', () => {
  process.env.APP_SECRET_KEY = 'key-one-abcdefg'
  const enc = encrypt('payload')
  process.env.APP_SECRET_KEY = 'key-two-abcdefg'
  assert.equal(decrypt(enc), '')
})

test('过短的密钥视为未配置', () => {
  process.env.APP_SECRET_KEY = 'short'
  assert.equal(hasEncryptionKey(), false)
})
